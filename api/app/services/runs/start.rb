# frozen_string_literal: true

module Runs
  # Starts a run: enforce one-active-run (the DB partial unique index is the
  # backstop), create the worktree + record base_sha, create the `queued` ai_run,
  # and POST to the harness's /runs. It does NOT emit `run_started` — the harness
  # emits that, and Rails transitions queued → running when it ingests it
  # (Runs::Finalize). Encodes reject-no-resume / revise-resumes.
  class Start
    class ActiveRunExists < StandardError; end
    class DirtyWorktree < StandardError; end
    class SessionArchived < StandardError; end

    # The pre-approval base — the 8 built-in tools the composer advertises ON
    # (kept in sync with packages/contracts BUILTIN_TOOLS; Rails can't import TS,
    # so this is the Ruby source of truth). Turning a tool OFF is modeled as
    # `disallowed_tools`, not by shrinking this set (only a bare disallowedTools
    # truly removes a tool — see design D1/D8).
    DEFAULT_ALLOWED_TOOLS = %w[Read Write Edit Bash Glob Grep WebSearch WebFetch].freeze
    # Until M7 a session has exactly one lane, so this is the whole lane space.
    # Named rather than inlined because the harness enforces one-active-run PER
    # LANE, and a bare "main" at the call site would hide where that comes from.
    DEFAULT_LANE = 'main'
    DEFAULT_PROVIDER = 'anthropic-direct'

    Result = Struct.new(:ai_run, :sidecar_status, keyword_init: true)

    def self.call(**)
      new(**).call
    end

    def initialize(session:, requested_by:, prompt:, model:, mode: 'fresh',
                   provider: DEFAULT_PROVIDER, lane: DEFAULT_LANE, effort: nil,
                   disallowed_tools: [], connectors: [], skills: [],
                   client: Sidecar::Client.new, worktree: nil)
      @session = session
      @requested_by = requested_by
      @prompt = prompt
      @model = model
      @mode = mode
      @provider = provider
      @lane = lane
      @effort = effort
      @disallowed_tools = disallowed_tools
      @connectors = connectors
      @skills = skills
      @client = client
      @worktree = worktree || Git::WorktreeManager.new(session)
    end

    def call
      preflight!

      revise = @mode == 'revise'
      prior = @session.ai_runs.active.first
      raise(ActiveRunExists) if prior && !revise

      # `chat` sessions run Claude in a plain working directory — no worktree, no
      # dirty check, no base_sha. `review` sessions use the git worktree.
      cwd = @session.mode == 'chat' ? chat_cwd : review_worktree!(revise)

      resume = resume_context?(revise)
      prior&.update!(status: 'superseded') if revise

      create_and_post!(cwd, resume)
    rescue ActiveRecord::RecordNotUnique
      # The partial unique index won the race: another active run exists.
      raise(ActiveRunExists)
    end

    private

    # Guards that must hold before any run is created, independent of mode. Archive
    # is a hard close: no new run may start on an archived session — enforced in the
    # service (not just the controller) so the invariant holds for every caller.
    def preflight!
      raise(SessionArchived) if @session.archived?
    end

    def chat_cwd
      @session.repository_path.presence || Git::WorktreeManager.repo_root
    end

    def review_worktree!(revise)
      path = @worktree.ensure_worktree!
      raise(DirtyWorktree) if !revise && @worktree.dirty?

      path
    end

    # Whether the new run inherits the session's existing conversation.
    #
    # The RULE is unchanged; only its carrier is. It used to ride on
    # `claude_session_id` — resume that SDK session and context came with it. The
    # harness now owns the record, so resumption is by harness session + lane and
    # this is the boolean that says whether to fold the prior surface into the
    # first request.
    #
    # A REJECT still severs the chain, and that is the whole point: reject reverts
    # the worktree, so the recorded conversation describes edits that no longer
    # exist. Resuming it would have Claude reason about files it cannot see
    #. `revise` deliberately does resume — it keeps the dirty tree.
    def resume_context?(revise)
      last = @session.ai_runs.order(:id).last
      return false if last.nil?
      return false if !revise && last.status == 'rejected'

      true
    end

    # If the sidecar refuses the start, drop the just-created run so no
    # queued/active run is left behind to block the session (queued counts toward
    # one-active-run); re-raise so the controller still surfaces the error.
    def create_and_post!(cwd, resume)
      run = create_run!
      status = post_to_harness(run, cwd, resume)
      Result.new(ai_run: run, sidecar_status: status)
    rescue Sidecar::Client::ActiveRunConflict, Sidecar::Client::TransportError
      run&.destroy
      raise
    end

    def create_run!
      AiRun.create!(
        session: @session,
        status: 'queued',
        requested_by: @requested_by,
        prompt: @prompt,
        model: @model
      )
    end

    def post_to_harness(run, cwd, resume)
      @client.start_run(base_payload(run, cwd, resume).merge(optional_payload)).status
    end

    def base_payload(run, cwd, resume)
      {
        run_id: run.id.to_s,
        session_id: @session.id.to_s,
        lane: @lane,
        repo_path: cwd,
        prompt: @prompt,
        requested_by: @requested_by.id.to_s,
        provider: @provider,
        model: @model,
        resume_context: resume,
        allowed_tools: DEFAULT_ALLOWED_TOOLS
      }
    end

    # Omitted rather than sent as nil: the harness treats an absent key as "today's
    # default", so a null would be a different request from no request.
    def optional_payload
      {
        effort: @effort,
        disallowed_tools: @disallowed_tools,
        connectors: @connectors,
        skills: @skills
      }.compact_blank
    end
  end
end
