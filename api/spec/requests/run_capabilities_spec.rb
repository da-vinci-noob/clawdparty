# frozen_string_literal: true

require 'rails_helper'

RSpec.describe('Run start capability selection') do
  let(:session) { create(:session, repository_path: '/repo/app') }
  let(:posted) { [] }

  before do
    wt_path = "/repo/.clawdparty/worktrees/session-#{session.id}"
    allow_any_instance_of(Git::WorktreeManager)
      .to(receive_messages(ensure_worktree!: wt_path, dirty?: false))

    captured = posted
    allow_any_instance_of(Sidecar::Client).to(receive(:start_run)) do |_client, payload|
      captured << payload
      Sidecar::Client::Result.new(status: 202, body: {})
    end

    stub_connectors('connectors' => [{ 'name' => 'github', 'transport' => 'stdio' }], 'source' => 'project')
    stub_skills('skills' => [{ 'name' => 'deploy', 'description' => 'Ship it' }], 'source' => 'user')
  end

  def stub_connectors(body)
    allow_any_instance_of(Sidecar::Client).to(receive(:list_connectors)
      .and_return(Sidecar::Client::Result.new(status: 200, body: body)))
  end

  def stub_skills(body)
    allow_any_instance_of(Sidecar::Client).to(receive(:list_skills)
      .and_return(Sidecar::Client::Result.new(status: 200, body: body)))
  end

  def start_run(role: 'editor', **caps)
    join_as(session, role: role)
    post("/api/sessions/#{session.id}/runs", params: { prompt: 'build it', model: 'm' }.merge(caps))
  end

  describe 'a valid selection' do
    it 'accepts it (202) and threads it to the sidecar' do
      expect do
        start_run(disallowed_tools: ['Bash'], connectors: ['github'], skills: ['deploy'])
      end.to(change(AiRun, :count).by(1))

      expect(response).to(have_http_status(:accepted))
      payload = posted.last
      expect(payload[:disallowed_tools]).to(eq(['Bash']))
      expect(payload[:connectors]).to(eq(['github']))
      expect(payload[:skills]).to(eq(['deploy']))
    end

    it 'accepts skills:"all"' do
      start_run(skills: 'all')
      expect(response).to(have_http_status(:accepted))
      expect(posted.last[:skills]).to(eq('all'))
    end
  end

  describe 'an unknown value is rejected before the run starts (422)' do
    it 'rejects an unknown tool id' do
      expect { start_run(disallowed_tools: ['Nope']) }.not_to(change(AiRun, :count))
      expect(response).to(have_http_status(:unprocessable_content))
      expect(response.parsed_body['errors'].first['message']).to(include('Nope'))
      expect(posted).to(be_empty)
    end

    it 'rejects an unknown connector name' do
      expect { start_run(connectors: ['ghost']) }.not_to(change(AiRun, :count))
      expect(response).to(have_http_status(:unprocessable_content))
      expect(posted).to(be_empty)
    end

    it 'rejects an unknown skill name' do
      expect { start_run(skills: ['ghost']) }.not_to(change(AiRun, :count))
      expect(response).to(have_http_status(:unprocessable_content))
      expect(posted).to(be_empty)
    end
  end

  describe 'fail-open when discovery is unavailable' do
    it 'passes an unvalidated connector through when the source is unavailable (202)' do
      stub_connectors('connectors' => [], 'source' => 'unavailable')
      start_run(connectors: ['anything'])
      expect(response).to(have_http_status(:accepted))
      expect(posted.last[:connectors]).to(eq(['anything']))
    end

    it 'passes an unvalidated skill through when the sidecar is unreachable (202)' do
      allow_any_instance_of(Sidecar::Client).to(receive(:list_skills)
        .and_raise(Sidecar::Client::TransportError, 'sidecar /skills failed: connection refused'))
      start_run(skills: ['whatever'])
      expect(response).to(have_http_status(:accepted))
      expect(posted.last[:skills]).to(eq(['whatever']))
    end
  end

  describe 'the capability surface rides behind the existing :run gate' do
    %w[reviewer viewer].each do |role|
      it "denies #{role} with 403 even with capability fields (no discovery, no run)" do
        expect do
          start_run(role: role, disallowed_tools: ['Bash'], connectors: ['github'])
        end.not_to(change(AiRun, :count))
        expect(response).to(have_http_status(:forbidden))
        expect(posted).to(be_empty)
      end
    end

    it 'keeps bypassPermissions owner-only when capabilities are set (editor → 403)' do
      expect do
        start_run(role: 'editor', permission_mode: 'bypassPermissions', disallowed_tools: ['Bash'])
      end.not_to(change { AiRun.where(status: 'queued').count })
      expect(response).to(have_http_status(:forbidden))
    end

    it 'lets an owner use bypassPermissions with capabilities (202)' do
      start_run(role: 'owner', permission_mode: 'bypassPermissions', disallowed_tools: ['Bash'])
      expect(response).to(have_http_status(:accepted))
      expect(posted.last[:disallowed_tools]).to(eq(['Bash']))
    end
  end
end
