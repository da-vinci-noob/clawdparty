# frozen_string_literal: true

require 'rails_helper'

# Managing host skills from the browser.
#
# Different in kind from the app's other writes, and the tests are shaped by why:
#
#   * A skill is INSTRUCTIONS CLAUDE WILL FOLLOW, so adding one is closer to granting a capability
#     than to editing a document → owner-only, and appended to the session timeline.
#   * The write lands OUTSIDE the session worktree (the repo's `.claude/skills`, or the host's) →
#     the scope is explicit, and `project` is the fallback because `host` reaches every session on
#     the machine.
#   * A removal destroys someone's work → the harness renames rather than unlinks, and the event
#     records where it went.
RSpec.describe('Skills management') do
  let(:session) { create(:session, repository_path: '/repo') }

  def stub_add(status: 200, body: { 'ok' => true, 'scope' => 'project', 'name' => 'deploy' })
    allow_any_instance_of(Harness::Client).to(receive(:add_skill)
      .and_return(Harness::Client::Result.new(status: status, body: body)))
  end

  def stub_remove(status: 200, body: { 'ok' => true, 'path' => '/repo/.claude/skills/deploy.removed' })
    allow_any_instance_of(Harness::Client).to(receive(:remove_skill)
      .and_return(Harness::Client::Result.new(status: status, body: body)))
  end

  def add(role: 'owner', **over)
    join_as(session, role: role)
    post("/api/sessions/#{session.id}/skills",
         params: { name: 'deploy', description: 'Ship it', body: '# Deploy' }.merge(over), as: :json)
  end

  describe 'POST /api/sessions/:id/skills' do
    it 'writes the skill and returns 201 for an owner' do
      stub_add
      add

      expect(response).to(have_http_status(:created))
    end

    it 'appends a skill_changed event naming the writer' do
      stub_add
      add

      event = Event.where(session: session, event_type: 'skill_changed').last
      # The audit trail. A file's mtime does not say who, and the room's other capability changes
      # are all events.
      expect(event.payload).to(include('action' => 'added', 'name' => 'deploy', 'scope' => 'project'))
      # Attributed to a PARTICIPANT, not to the system: "who granted this capability" is the
      # question an audit trail exists to answer.
      expect(event.actor_kind).to(eq('user'))
      expect(event.actor_participant_id).to(be_present)
    end

    it 'defaults to the PROJECT scope, never the host' do
      client = instance_spy(Harness::Client,
                            add_skill: Harness::Client::Result.new(status: 200, body: { 'ok' => true }))
      allow(Harness::Client).to(receive(:new).and_return(client))
      add

      # A host skill reaches every session on the machine and the developer's own terminal Claude
      # Code, so it is asked for explicitly and is never what an omitted parameter means.
      expect(client).to(have_received(:add_skill).with(hash_including(scope: 'project')))
    end

    it 'honours an explicit host scope' do
      client = instance_spy(Harness::Client,
                            add_skill: Harness::Client::Result.new(status: 200, body: { 'ok' => true }))
      allow(Harness::Client).to(receive(:new).and_return(client))
      add(scope: 'host')

      expect(client).to(have_received(:add_skill).with(hash_including(scope: 'host')))
      expect(Event.where(session: session, event_type: 'skill_changed').last.payload['scope']).to(eq('host'))
    end

    it 'records a replacement as replaced, not added' do
      stub_add
      add(replace: true)

      expect(Event.where(session: session, event_type: 'skill_changed').last.payload['action']).to(eq('replaced'))
    end

    %w[editor reviewer viewer].each do |role|
      it "refuses a #{role} with 403 and writes nothing" do
        stub_add
        add(role: role)

        expect(response).to(have_http_status(:forbidden))
        expect(Event.where(session: session, event_type: 'skill_changed')).to(be_empty)
      end
    end

    it 'refuses a non-participant with 404, not 403' do
      # Anti-enumeration: a stranger learns nothing about whether the session exists.
      post("/api/sessions/#{session.id}/skills", params: { name: 'x' }, as: :json)
      expect(response).to(have_http_status(:not_found))
    end

    it 'turns the harness refusal into a message a participant can act on' do
      stub_add(status: 422, body: { 'error' => 'invalid_name' })
      add(name: 'Bad Name')

      expect(response).to(have_http_status(:unprocessable_content))
      expect(response.parsed_body['errors'].first['message']).to(include('lowercase name with hyphens'))
    end

    it 'explains an existing name rather than overwriting it' do
      stub_add(status: 422, body: { 'error' => 'exists' })
      add

      expect(response.parsed_body['errors'].first['message']).to(include('already exists'))
      expect(Event.where(session: session, event_type: 'skill_changed')).to(be_empty)
    end
  end

  describe 'DELETE /api/sessions/:id/skills/:name' do
    def remove(role: 'owner', name: 'deploy', **params)
      join_as(session, role: role)
      delete("/api/sessions/#{session.id}/skills/#{name}", params: params, as: :json)
    end

    it 'moves the skill aside for an owner and records where it went' do
      stub_remove
      remove

      expect(response).to(have_http_status(:ok))
      event = Event.where(session: session, event_type: 'skill_changed').last
      # `moved_to` exists because nothing is deleted: the record says where to look for it.
      expect(event.payload).to(include('action' => 'removed', 'moved_to' => 'deploy.removed'))
    end

    %w[editor reviewer viewer].each do |role|
      it "refuses a #{role} with 403" do
        stub_remove
        remove(role: role)

        expect(response).to(have_http_status(:forbidden))
        expect(Event.where(session: session, event_type: 'skill_changed')).to(be_empty)
      end
    end

    it 'reports a name that is not in this scope as 404' do
      stub_remove(status: 404, body: { 'error' => 'not_found' })
      remove(name: 'ghost')

      expect(response).to(have_http_status(:not_found))
      expect(response.parsed_body['errors'].first['message']).to(include('not in this scope'))
    end

    it 'returns 502 when the harness is unreachable' do
      allow_any_instance_of(Harness::Client).to(receive(:remove_skill)
        .and_raise(Harness::Client::TransportError, 'harness /skills/remove failed'))
      remove

      expect(response).to(have_http_status(:bad_gateway))
    end
  end
end
