# frozen_string_literal: true

require 'rails_helper'

RSpec.describe('Run control') do
  let(:session) { create(:session) }

  before do
    # No real harness / git in request specs: stub the seams.
    wt_path = "/repo/.clawdparty/worktrees/session-#{session.id}"
    allow_any_instance_of(Git::WorktreeManager)
      .to(receive_messages(ensure_worktree!: wt_path, dirty?: false, base_sha: '0' * 40))
    allow_any_instance_of(Harness::Client).to(receive(:start_run)
      .and_return(Harness::Client::Result.new(status: 202, body: {})))
    allow_any_instance_of(Harness::Client).to(receive(:send_message)
      .and_return(Harness::Client::Result.new(status: 200, body: {})))
    allow_any_instance_of(Harness::Client).to(receive(:interrupt)
      .and_return(Harness::Client::Result.new(status: 200, body: {})))
  end

  def start_run
    post("/api/sessions/#{session.id}/runs", params: { prompt: 'build it', model: 'm' })
  end

  # Every example above names a model explicitly, which is why the hardcoded default went
  # unnoticed: the resolution path was never entered. These cover it.
  describe 'POST /api/sessions/:id/runs when the harness REFUSES' do
    it 'forwards the harness reason and leaves no queued run behind' do
      # RAISES rather than returning a 500 Result. The status check lives inside
      # `Harness::Client#start_run`, so stubbing that method to return a 500 would replace the
      # very code under test and this spec would assert nothing. Which statuses refuse is
      # `client_spec.rb`'s subject; what the app does about a refusal is this one's.
      allow_any_instance_of(Harness::Client).to(receive(:start_run)
        .and_raise(Harness::Client::Refused,
                   'store unavailable for session 35: incompatible_version'))
      join_as(session, role: 'owner')

      expect do
        post("/api/sessions/#{session.id}/runs", params: { prompt: 'go', model: 'm' })
      end.not_to(change(AiRun, :count))

      # Previously: 202 Accepted, a `queued` run, and 15s later a swept `run_failed` reading
      # `harness_unreachable` — which is false and sends the operator looking at the network.
      expect(response).to(have_http_status(:unprocessable_content))
      expect(response.parsed_body['errors'].first['message']).to(include('incompatible_version'))
    end

    it 'does not leave the session blocked for the next run' do
      allow_any_instance_of(Harness::Client).to(receive(:start_run)
        .and_raise(Harness::Client::Refused, 'boom'))
      join_as(session, role: 'owner')
      post("/api/sessions/#{session.id}/runs", params: { prompt: 'go', model: 'm' })

      # `queued` counts toward index_ai_runs_one_active_per_session, so a run left behind
      # would 409 every subsequent attempt until the sweeper caught it.
      allow_any_instance_of(Harness::Client).to(receive(:start_run)
        .and_return(Harness::Client::Result.new(status: 202, body: {})))
      post("/api/sessions/#{session.id}/runs", params: { prompt: 'again', model: 'm' })

      expect(response).to(have_http_status(:accepted))
    end
  end

  describe 'POST /api/sessions/:id/runs with NO model named' do
    def providers(list)
      allow_any_instance_of(Harness::Client).to(receive(:list_models)
        .and_return(Harness::Client::Result.new(status: 200, body: { 'providers' => list })))
    end

    it "uses the chosen provider's own first model, not a hardcoded id" do
      providers([{ 'id' => 'anthropic-bedrock', 'displayName' => 'Amazon Bedrock',
                   'available' => true,
                   'models' => [{ 'id' => 'anthropic.claude-opus-5', 'displayName' => 'Opus 5' }] }])
      join_as(session, role: 'owner')

      post("/api/sessions/#{session.id}/runs",
           params: { prompt: 'build it', provider: 'anthropic-bedrock' })

      # A bare `claude-opus-4-8` is REJECTED on Bedrock, so the old default made every
      # unspecified run on a Bedrock host fail at dispatch with an invalid model id.
      expect(response).to(have_http_status(:accepted))
      expect(AiRun.last.model).to(eq('anthropic.claude-opus-5'))
    end

    it 'refuses with the provider’s remedy when nothing can be resolved' do
      providers([{ 'id' => 'anthropic-bedrock', 'displayName' => 'Amazon Bedrock',
                   'available' => false, 'reason' => 'unreachable',
                   'remedy' => 'Run `aws sso login`.', 'models' => [] }])
      join_as(session, role: 'owner')

      expect do
        post("/api/sessions/#{session.id}/runs",
             params: { prompt: 'build it', provider: 'anthropic-bedrock' })
      end.not_to(change(AiRun, :count))

      # 422 with the fix named, not a 500 and not a queued run that dies later.
      expect(response).to(have_http_status(:unprocessable_content))
      expect(response.parsed_body['errors'].first['message']).to(include('aws sso login'))
    end
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

    it 'surfaces 409 when the session is archived (hard close blocks new runs)' do
      join_as(session, role: 'owner')
      session.update!(status: 'archived')
      expect { start_run }.not_to(change(AiRun, :count))
      expect(response).to(have_http_status(:conflict))
      expect(response.parsed_body['errors'].first['message']).to(be_present)
    end

    it 'surfaces a harness transport failure as 502 (not an unhandled 500) and leaves no queued run' do
      join_as(session, role: 'owner')
      allow_any_instance_of(Harness::Client).to(receive(:start_run)
        .and_raise(Harness::Client::TransportError, 'harness /runs failed: connection refused'))
      expect { start_run }.not_to(change { AiRun.where(status: 'queued').count })
      expect(response).to(have_http_status(:bad_gateway))
      expect(response.parsed_body['errors']).to(be_present)
    end

    it 'surfaces a worktree/git failure as a clean error (not an unhandled 500) with no queued run' do
      join_as(session, role: 'owner')
      allow_any_instance_of(Git::WorktreeManager).to(receive(:ensure_worktree!)
        .and_raise(Git::WorktreeManager::GitError, 'not a git repository'))
      expect { start_run }.not_to(change { AiRun.where(status: 'queued').count })
      expect(response).to(have_http_status(:unprocessable_content))
      expect(response.parsed_body['errors'].first['message']).to(be_present)
    end
  end

  # The permission_mode blocks are GONE with the parameter itself (CHANGELOG B2):
  # a mode allowlist, its 422, and the owner-gated bypassPermissions all described
  # an Agent SDK concept. Policy now lives at the `tool:before` extension point and
  # in the per-run tool set, which other specs test directly. What survives here is
  # the assertion that the removed route is actually gone.
  describe 'POST /api/runs/:id/permission_mode is removed' do
    it 'no longer routes (404), so the surface cannot quietly come back' do
      run = create(:ai_run, session: session, status: 'running')
      join_as(session, role: 'owner')

      post("/api/runs/#{run.id}/permission_mode", params: { permission_mode: 'acceptEdits' })

      expect(response).to(have_http_status(:not_found))
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

    it 'reconciles an orphaned run when the harness no longer has it (no dead-end 404)' do
      # e.g. the harness restarted mid-run: it returns UnknownRun, but the run is
      # still "running" in Rails. Interrupt should finalize it (emit run_interrupted
      # → terminal) so the session unblocks, not relay a 404 that leaves it stuck.
      join_as(session, role: 'owner')
      allow_any_instance_of(Harness::Client).to(receive(:interrupt)
        .and_raise(Harness::Client::UnknownRun, "run #{run.id} unknown"))

      post("/api/runs/#{run.id}/interrupt")
      expect(response).to(have_http_status(:ok))
      expect(run.session.events.exists?(ai_run_id: run.id, event_type: 'run_interrupted')).to(be(true))
      expect(run.reload.active?).to(be(false)) # no longer blocks the session
    end
  end
end
