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
    expect(payload[:lane]).to(eq('main'))
    expect(payload[:provider]).to(eq('anthropic-direct'))
    expect(payload[:allowed_tools]).to(include('Bash', 'Write'))
    # Both are gone from the protocol: permission_mode was an Agent SDK concept,
    # and resumption is now by harness session + lane (CHANGELOG B1/B2).
    expect(payload).not_to(have_key(:permission_mode))
    expect(payload).not_to(have_key(:claude_session_id))
  end

  describe 'capability selection (disallowed_tools / connectors / skills)' do
    def start_with(**caps)
      described_class.call(session: session, requested_by: owner, prompt: 'build it',
                           model: 'claude-opus-4-8', client: client, worktree: worktree, **caps)
    end

    it 'pre-approves all 8 advertised built-in tools by default' do
      expect(described_class::DEFAULT_ALLOWED_TOOLS)
        .to(eq(%w[Read Write Edit Bash Glob Grep WebSearch WebFetch]))
      start
      expect(posted.last[:allowed_tools]).to(eq(%w[Read Write Edit Bash Glob Grep WebSearch WebFetch]))
    end

    it 'omits the capability keys entirely when nothing is selected (prior behavior)' do
      start
      payload = posted.last
      expect(payload).not_to(have_key(:disallowed_tools))
      expect(payload).not_to(have_key(:connectors))
      expect(payload).not_to(have_key(:skills))
    end

    it 'threads a selection into the sidecar payload' do
      start_with(disallowed_tools: ['Bash'], connectors: ['github'], skills: ['deploy'])
      payload = posted.last
      expect(payload[:disallowed_tools]).to(eq(['Bash']))
      expect(payload[:connectors]).to(eq(['github']))
      expect(payload[:skills]).to(eq(['deploy']))
    end

    it 'passes skills:"all" through as the literal string' do
      start_with(skills: 'all')
      expect(posted.last[:skills]).to(eq('all'))
    end
  end

  it 'rejects a second active run (one-active-run; surfaced as ActiveRunExists)' do
    create(:ai_run, session: session, status: 'running')
    expect { start }.to(raise_error(Runs::Start::ActiveRunExists))
  end

  it 'allows a new run once the prior run is terminal' do
    create(:ai_run, session: session, status: 'completed_clean')
    expect { start }.not_to(raise_error)
  end

  # The RULE is unchanged; only its carrier is. It used to ride on
  # claude_session_id (resume that SDK session, context came with it). The harness
  # now owns the record, so `resume_context` says whether to fold the prior surface
  # into the first request. Deliberately still tested at the same granularity:
  # losing this coverage during the swap is how a reject would silently start
  # resuming reverted edits again.
  describe 'reject severs the resumed context; only revise resumes' do
    it 'does NOT resume on a fresh start after a reject' do
      create(:ai_run, session: session, status: 'rejected')
      start
      expect(posted.last[:resume_context]).to(be(false))
    end

    it 'resumes on revise and supersedes the prior run' do
      allow(worktree).to(receive(:dirty?).and_return(true))
      prior = create(:ai_run, session: session, status: 'awaiting_review')
      start(mode: 'revise')
      expect(posted.last[:resume_context]).to(be(true))
      expect(prior.reload.status).to(eq('superseded'))
    end

    it 'resumes on revise EVEN IF the prior run was rejected (revise keeps the tree)' do
      allow(worktree).to(receive(:dirty?).and_return(true))
      create(:ai_run, session: session, status: 'rejected')
      start(mode: 'revise')
      expect(posted.last[:resume_context]).to(be(true))
    end
  end

  describe 'fresh follow-ups resume the prior conversation (context persists)' do
    it 'resumes on a fresh follow-up after a clean run' do
      create(:ai_run, session: session, status: 'completed_clean')
      start
      expect(posted.last[:resume_context]).to(be(true))
    end

    it 'does not resume when the session has no prior run at all' do
      start
      expect(posted.last[:resume_context]).to(be(false))
    end

    it 'looks at the LATEST prior run, not any earlier one' do
      create(:ai_run, session: session, status: 'completed_clean')
      create(:ai_run, session: session, status: 'rejected')
      start
      expect(posted.last[:resume_context]).to(be(false))
    end
  end

  it 'refuses a fresh start on a dirty worktree' do
    allow(worktree).to(receive(:dirty?).and_return(true))
    expect { start }.to(raise_error(Runs::Start::DirtyWorktree))
  end

  describe 'archive is a hard close (no new run on an archived session)' do
    it 'refuses to start on an archived session and posts nothing' do
      session.update!(status: 'archived')
      expect { start }.to(raise_error(Runs::Start::SessionArchived))
      expect(posted).to(be_empty)
      expect(session.ai_runs.count).to(eq(0))
    end

    it 'still starts on an active session' do
      expect { start }.not_to(raise_error)
    end
  end

  # Replaces the permission_mode block, which tested a parameter that no longer
  # exists. The per-run knobs are now provider / lane / effort.
  describe 'per-run provider, lane and effort' do
    def start_with(**over)
      described_class.call(session: session, requested_by: owner, prompt: 'build it',
                           model: 'claude-opus-4-8', client: client, worktree: worktree, **over)
    end

    it 'defaults to the anthropic-direct provider on the main lane' do
      start
      expect(posted.last).to(include(provider: 'anthropic-direct', lane: 'main'))
    end

    it 'forwards an explicit provider and lane' do
      start_with(provider: 'anthropic-bedrock', lane: 'review')
      expect(posted.last).to(include(provider: 'anthropic-bedrock', lane: 'review'))
    end

    it 'omits effort entirely when unset, rather than sending a null' do
      start
      expect(posted.last).not_to(have_key(:effort))
    end

    it 'forwards effort when set' do
      start_with(effort: 'high')
      expect(posted.last[:effort]).to(eq('high'))
    end
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

    it 'resumes the prior conversation on a follow-up (chat context persists)' do
      create(:ai_run, session: session, status: 'completed_clean')
      start
      expect(posted.last[:resume_context]).to(be(true))
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
