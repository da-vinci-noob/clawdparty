# frozen_string_literal: true

require 'rails_helper'

RSpec.describe('Run control') do
  let(:session) { create(:session) }

  before do
    # No real sidecar / git in request specs: stub the seams.
    wt_path = "/repo/.clawdparty/worktrees/session-#{session.id}"
    allow_any_instance_of(Git::WorktreeManager)
      .to(receive_messages(ensure_worktree!: wt_path, dirty?: false))
    allow_any_instance_of(Sidecar::Client).to(receive(:start_run)
      .and_return(Sidecar::Client::Result.new(status: 202, body: {})))
    allow_any_instance_of(Sidecar::Client).to(receive(:send_message)
      .and_return(Sidecar::Client::Result.new(status: 200, body: {})))
    allow_any_instance_of(Sidecar::Client).to(receive(:interrupt)
      .and_return(Sidecar::Client::Result.new(status: 200, body: {})))
  end

  def start_run
    post("/api/sessions/#{session.id}/runs", params: { prompt: 'build it', model: 'm' })
  end

  describe 'POST /api/sessions/:id/runs (role matrix)' do
    it 'allows owner to start a run (202)' do
      join_as(session, role: 'owner')
      expect { start_run }.to(change(AiRun, :count).by(1))
      expect(response).to(have_http_status(:accepted))
      expect(response.parsed_body['status']).to(eq('queued'))
    end

    it 'allows editor to start a run' do
      join_as(session, role: 'editor')
      start_run
      expect(response).to(have_http_status(:accepted))
    end

    %w[reviewer viewer].each do |role|
      it "denies #{role} with 403" do
        join_as(session, role: role)
        expect { start_run }.not_to(change(AiRun, :count))
        expect(response).to(have_http_status(:forbidden))
      end
    end

    it 'refuses a non-participant with 404 (not 403)' do
      other = create(:session)
      join_as(session, role: 'owner') # participant of `session`, not `other`
      post("/api/sessions/#{other.id}/runs", params: { prompt: 'x', model: 'm' })
      expect(response).to(have_http_status(:not_found))
    end

    it 'surfaces 409 when a run is already active' do
      join_as(session, role: 'owner')
      create(:ai_run, session: session, status: 'running')
      start_run
      expect(response).to(have_http_status(:conflict))
    end

    it 'surfaces a sidecar transport failure as 502 (not an unhandled 500) and leaves no queued run' do
      join_as(session, role: 'owner')
      allow_any_instance_of(Sidecar::Client).to(receive(:start_run)
        .and_raise(Sidecar::Client::TransportError, 'sidecar /runs failed: connection refused'))
      expect { start_run }.not_to(change { AiRun.where(status: 'queued').count })
      expect(response).to(have_http_status(:bad_gateway))
      expect(response.parsed_body['errors']).to(be_present)
    end
  end

  describe 'POST /api/runs/:id/messages and /interrupt' do
    let!(:run) { create(:ai_run, session: session, status: 'running') }

    it 'owner may send a follow-up (200) and interrupt (200)' do
      join_as(session, role: 'owner')
      post("/api/runs/#{run.id}/messages", params: { message: 'more' })
      expect(response).to(have_http_status(:ok))
      post("/api/runs/#{run.id}/interrupt")
      expect(response).to(have_http_status(:ok))
    end

    it 'denies reviewer the follow-up and interrupt with 403' do
      join_as(session, role: 'reviewer')
      post("/api/runs/#{run.id}/messages", params: { message: 'more' })
      expect(response).to(have_http_status(:forbidden))
      post("/api/runs/#{run.id}/interrupt")
      expect(response).to(have_http_status(:forbidden))
    end
  end
end
