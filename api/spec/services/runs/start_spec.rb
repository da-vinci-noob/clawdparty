# frozen_string_literal: true

require 'rails_helper'

RSpec.describe(Runs::Start) do
  let(:session) { create(:session) }
  let(:owner) { create(:participant, session: session, role: 'owner') }

  # A fake worktree manager (no real git): clean by default, records base_sha.
  let(:worktree) do
    instance_double(
      Git::WorktreeManager,
      ensure_worktree!: "/repo/.clawdparty/worktrees/session-#{session.id}",
      dirty?: false
    )
  end

  # A fake sidecar client that records the start_run payload and returns 202.
  let(:posted) { [] }
  let(:client) do
    p = posted
    Class.new do
      define_method(:start_run) do |payload|
        p << payload
        Sidecar::Client::Result.new(status: 202, body: { 'run_id' => payload[:run_id], 'status' => 'running' })
      end
    end.new
  end

  def start(mode: 'fresh')
    described_class.call(session: session, requested_by: owner, prompt: 'build it',
                         model: 'claude-opus-4-8', mode: mode, client: client, worktree: worktree)
  end

  it 'creates a queued run and posts the contract payload WITHOUT emitting run_started' do
    expect { @result = start }.to(change { session.ai_runs.count }.by(1))
    run = @result.ai_run

    expect(run.status).to(eq('queued'))
    expect(run.requested_by).to(eq(owner))
    # Rails does NOT emit run_started — the sidecar does (no run_started event here).
    expect(Event.where(ai_run_id: run.id, event_type: 'run_started').count).to(eq(0))

    payload = posted.last
    expect(payload[:requested_by]).to(eq(owner.id.to_s))
    expect(payload[:repo_path]).to(eq("/repo/.clawdparty/worktrees/session-#{session.id}"))
    expect(payload[:permission_mode]).to(eq('acceptEdits'))
    expect(payload[:allowed_tools]).to(include('Bash', 'Write'))
  end

  it 'rejects a second active run (one-active-run; surfaced as ActiveRunExists)' do
    create(:ai_run, session: session, status: 'running')
    expect { start }.to(raise_error(Runs::Start::ActiveRunExists))
  end

  it 'allows a new run once the prior run is terminal' do
    create(:ai_run, session: session, status: 'completed_clean')
    expect { start }.not_to(raise_error)
  end

  describe 'reject severs claude_session_id; only revise resumes' do
    it 'does NOT pass claude_session_id on a fresh start (e.g. after a reject)' do
      create(:ai_run, session: session, status: 'rejected', claude_session_id: 'old-sess')
      start
      expect(posted.last).not_to(have_key(:claude_session_id))
    end

    it 'passes the prior claude_session_id on revise and supersedes the prior run' do
      allow(worktree).to(receive(:dirty?).and_return(true))
      prior = create(:ai_run, session: session, status: 'awaiting_review', claude_session_id: 'resume-me')
      start(mode: 'revise')
      expect(posted.last[:claude_session_id]).to(eq('resume-me'))
      expect(prior.reload.status).to(eq('superseded'))
    end
  end

  it 'refuses a fresh start on a dirty worktree' do
    allow(worktree).to(receive(:dirty?).and_return(true))
    expect { start }.to(raise_error(Runs::Start::DirtyWorktree))
  end

  describe 'chat mode (no worktree; cwd = working directory)' do
    let(:session) { create(:session, mode: 'chat', repository_path: '/repo/some/dir') }

    it 'does NOT create a worktree and pins cwd to the session working directory' do
      start
      # `worktree` is an instance_double (a spy) — assert ensure_worktree! was never called.
      expect(worktree).not_to(have_received(:ensure_worktree!))
      expect(posted.last[:repo_path]).to(eq('/repo/some/dir'))
    end

    it 'still enforces one-active-run' do
      create(:ai_run, session: session, status: 'running')
      expect { start }.to(raise_error(Runs::Start::ActiveRunExists))
    end
  end

  describe 'sidecar rejects the start (must not orphan a queued run)' do
    let(:client) do
      Class.new do
        def start_run(_payload)
          raise(Sidecar::Client::ActiveRunConflict, 'sidecar reports a run already active')
        end
      end.new
    end

    it 'does not leave a queued run behind when the sidecar returns 409' do
      expect { start }.to(raise_error(Sidecar::Client::ActiveRunConflict))
      expect(session.ai_runs.where(status: 'queued')).to(be_empty)
    end

    it 'frees the session so a later start can succeed once the sidecar is free' do
      expect { start }.to(raise_error(Sidecar::Client::ActiveRunConflict))
      expect(session.reload.ai_runs.active).to(be_empty)
    end
  end

  context 'when the sidecar is unreachable (transport error)' do
    let(:client) do
      Class.new do
        def start_run(_payload)
          raise(Sidecar::Client::TransportError, 'sidecar /runs failed: connection refused')
        end
      end.new
    end

    it 'does not orphan a queued run' do
      expect { start }.to(raise_error(Sidecar::Client::TransportError))
      expect(session.ai_runs.where(status: 'queued')).to(be_empty)
    end
  end
end
