# frozen_string_literal: true

require 'rails_helper'

# who may read the extension set, who may change it, and whether a
# change is attributable.
#
# The split is deliberate and asymmetric: READING is open to every participant, because which
# `tool:before` gate is in force decides what Claude may do — a viewer watching a refusal should be
# able to see which rule refused. CHANGING is owner-only, the same gate as invites, archive and
# skills, because turning a gate off is closer to granting a capability than to editing a setting.
RSpec.describe('Session extensions') do
  let(:session) { create(:session) }
  let(:plugin_id) { 'bundled:deny-destructive-bash' }

  def stub_list(enabled: true)
    allow_any_instance_of(Harness::Client).to(receive(:list_plugins).and_return(
                                                Harness::Client::Result.new(
                                                  status: 200,
                                                  body: { 'plugins' => [{ 'id' => plugin_id, 'version' => '1.0.0',
                                                                          'origin' => 'bundled',
                                                                          'enabled' => enabled }] }
                                                )
                                              ))
  end

  def stub_toggle(status: 200, body: nil)
    allow_any_instance_of(Harness::Client).to(receive(:set_plugin_enabled).and_return(
                                                Harness::Client::Result.new(
                                                  status: status,
                                                  body: body || { 'plugin_id' => plugin_id, 'active' => [] }
                                                )
                                              ))
  end

  describe 'GET /api/sessions/:id/plugins' do
    %w[owner editor reviewer viewer].each do |role|
      it "lets a #{role} read the set" do
        stub_list
        join_as(session, role: role)

        get("/api/sessions/#{session.id}/plugins")

        expect(response).to(have_http_status(:ok))
        expect(response.parsed_body['plugins'].first['id']).to(eq(plugin_id))
      end
    end

    it 'refuses a non-participant with 404 (anti-enumeration)' do
      stub_list
      join_as(create(:session), role: 'owner')

      get("/api/sessions/#{session.id}/plugins")

      expect(response).to(have_http_status(:not_found))
    end
  end

  describe 'PATCH /api/sessions/:id/plugins/:id' do
    it 'lets an OWNER disable one, and records who did it' do
      stub_toggle
      participant = join_as(session, role: 'owner')

      expect do
        patch("/api/sessions/#{session.id}/plugins/#{plugin_id}",
              params: { enabled: false }, as: :json)
      end.to(change { session.events.where(event_type: 'plugin_disabled').count }.by(1))

      expect(response).to(have_http_status(:ok))
      event = session.events.where(event_type: 'plugin_disabled').last
      # Attributable, not merely recorded: "a rule was turned off" without a name is an audit trail
      # nobody can act on.
      expect(event.actor_participant_id).to(eq(participant.id))
      expect(event.payload['id']).to(eq(plugin_id))
    end

    it 'appends plugin_enabled when enabling' do
      stub_toggle
      join_as(session, role: 'owner')

      expect do
        patch("/api/sessions/#{session.id}/plugins/#{plugin_id}", params: { enabled: true }, as: :json)
      end.to(change { session.events.where(event_type: 'plugin_enabled').count }.by(1))
    end

    it 'carries the RESOLVED set on the event, so a late joiner needs no extra fetch' do
      stub_toggle(body: { 'plugin_id' => plugin_id, 'active' => ['bundled:deny-out-of-tree-write'] })
      join_as(session, role: 'owner')

      patch("/api/sessions/#{session.id}/plugins/#{plugin_id}", params: { enabled: false }, as: :json)

      event = session.events.where(event_type: 'plugin_disabled').last
      expect(event.payload['active']).to(eq(['bundled:deny-out-of-tree-write']))
    end

    %w[editor reviewer viewer].each do |role|
      it "refuses a #{role} with 403 and appends nothing" do
        stub_toggle
        join_as(session, role: role)

        expect do
          patch("/api/sessions/#{session.id}/plugins/#{plugin_id}", params: { enabled: false }, as: :json)
        end.not_to(change(Event, :count))

        expect(response).to(have_http_status(:forbidden))
      end
    end

    it 'refuses an unauthenticated request with 404' do
      patch("/api/sessions/#{session.id}/plugins/#{plugin_id}", params: { enabled: false }, as: :json)
      expect(response).to(have_http_status(:not_found))
    end

    it 'refuses a missing `enabled` rather than defaulting it' do
      join_as(session, role: 'owner')

      patch("/api/sessions/#{session.id}/plugins/#{plugin_id}", params: {}, as: :json)

      # Either default would silently do the opposite of what half of callers meant.
      expect(response).to(have_http_status(:bad_request))
    end

    it "surfaces the harness's refusal verbatim" do
      stub_toggle(status: 422, body: { 'error' => 'plugin_refused',
                                       'message' => 'unknown extension: bundled:nope' })
      join_as(session, role: 'owner')

      patch("/api/sessions/#{session.id}/plugins/bundled:nope", params: { enabled: true }, as: :json)

      expect(response).to(have_http_status(:unprocessable_content))
      expect(response.parsed_body['errors'].first['message']).to(include('unknown extension'))
    end

    it 'appends NO event when the harness refused' do
      stub_toggle(status: 422, body: { 'message' => 'nope' })
      join_as(session, role: 'owner')

      expect do
        patch("/api/sessions/#{session.id}/plugins/bundled:nope", params: { enabled: true }, as: :json)
      end.not_to(change(Event, :count))
      # The record and its announcement must not disagree: an event for a change that did not happen
      # would tell the room a rule was off while the harness still had it on.
    end

    it 'reports a harness outage as 502, not as a refusal' do
      allow_any_instance_of(Harness::Client)
        .to(receive(:set_plugin_enabled).and_raise(Harness::Client::TransportError, 'down'))
      join_as(session, role: 'owner')

      patch("/api/sessions/#{session.id}/plugins/#{plugin_id}", params: { enabled: false }, as: :json)

      # "The harness refused" and "the harness is unreachable" call for different actions.
      expect(response).to(have_http_status(:bad_gateway))
    end
  end

  describe 'there is no install endpoint' do
    it 'exposes no route for installing a third-party extension' do
      # by construction: a `worker_thread` with `env: {}` isolates the environment and
      # nothing else, so third-party loading is not built. Asserted as an ABSENCE so adding one is a
      # deliberate act that fails this test first.
      paths = Rails.application.routes.routes.map { |r| r.path.spec.to_s }

      expect(paths).not_to(include(a_string_matching(%r{plugins/install})))
      expect(paths.grep(%r{sessions/:session_id/plugins}).sort)
        .to(eq(['/api/sessions/:session_id/plugins(.:format)',
                '/api/sessions/:session_id/plugins/:id(.:format)']))
    end
  end
end
