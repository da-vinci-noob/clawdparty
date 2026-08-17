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

    # The built-in tools a run has, by their HARNESS REGISTRY NAME (the Ruby copy of
    # packages/contracts BUILTIN_TOOLS; Rails cannot import TS). Used to VALIDATE a
    # `disallowed_tools` selection — nothing else. It was `DEFAULT_ALLOWED_TOOLS` and
    # was sent as an `allowed_tools` payload field that no consumer read: an
    # allow-list only pre-approves, and the harness's real gate is the `tool:before`
    # extension point plus dropping the declaration outright.
    #
    # These were the Agent SDK's capitalized names originally. Nothing answered to
    # them once the SDK left, so `disallowed_tools` silently matched no tool at all.
    BUILTIN_TOOLS = %w[read str_replace_based_edit_tool bash glob grep web_search web_fetch].freeze
    # The lane a run belongs to when the caller names none — and the lane every pre-M7 session is
    # implicitly in, which is why its worktree path and branch keep their un-suffixed form.
    # Named rather than inlined because one-active-run is enforced per (session, lane) on both
    # sides now, and a bare "main" at the call site would hide where that comes from.
    DEFAULT_LANE = 'main'
    DEFAULT_PROVIDER = 'anthropic-direct'

    Result = Struct.new(:ai_run, :harness_status, keyword_init: true)

    def self.call(**)
      new(**).call
    end

    def initialize(session:, requested_by:, prompt:, model:, mode: 'fresh',
                   provider: nil, lane: DEFAULT_LANE, effort: nil,
                   disallowed_tools: [], connectors: [], skills: [],
                   client: Harness::Client.new, worktree: nil)
      @session = session
      @requested_by = requested_by
      @prompt = prompt
      # An explicit choice wins; the session's Settings default is what a run starts with when the
      # composer is left alone; the built-in constant is the last resort. `provider` defaulted
      # to the constant in the signature before, which made a session default unreachable — the
      # caller always passed something.
      @model = model.presence || session.default_model
      @mode = mode
      @provider = provider.presence || session.default_provider.presence || DEFAULT_PROVIDER
      @lane = lane
      @effort = effort
      @disallowed_tools = disallowed_tools
      @connectors = connectors
      @skills = skills
      @client = client
      # Per-lane worktree: two lanes cannot share a checkout, because finalize reads the
      # whole working tree and reject reverts it.
      @worktree = worktree || Git::WorktreeManager.new(session, lane: @lane)
    end

    def call
      preflight!

      revise = @mode == 'revise'
      # PER LANE. One active run per session was the MVP rule and the DB index was the
      # backstop; both are now per (session, lane), so a second lane is startable while the first
      # is still running — which is the whole of.
      prior = @session.ai_runs.active.where(lane: @lane).first
      raise(ActiveRunExists) if prior && !revise

      # `chat` sessions run Claude in a plain working directory — no worktree, no
      # dirty check, no base_sha. `review` sessions use the git worktree.
      cwd = @session.mode == 'chat' ? chat_cwd : review_worktree!(revise)
      # NULL for chat, which has no worktree to anchor to. For review it is the floor the diff is
      # taken from AND the range `Git::LaneConflicts` needs to see what an already-COMMITTED sibling
      # lane touched — without it that conflict is never reported.
      base = @session.mode == 'chat' ? nil : @worktree.base_sha

      resume = resume_context?(revise)
      prior&.update!(status: 'superseded') if revise

      create_and_post!(cwd, resume, base)
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
    # Scoped to THIS LANE. A reject severs the rejected lane's context and must
    # not leak into another: reading the session's latest run across all lanes would let lane B's
    # rejection sever lane A, and would resume lane A's conversation into lane B.
    def resume_context?(revise)
      last = @session.ai_runs.where(lane: @lane).order(:id).last
      return false if last.nil?
      return false if !revise && last.status == 'rejected'

      true
    end

    # If the harness refuses the start, drop the just-created run so no
    # queued/active run is left behind to block the session (queued counts toward
    # one-active-run); re-raise so the controller still surfaces the error.
    def create_and_post!(cwd, resume, base_sha)
      run = create_run!(base_sha)
      status = post_to_harness(run, cwd, resume)
      Result.new(ai_run: run, harness_status: status)
    rescue Harness::Client::ActiveRunConflict, Harness::Client::TransportError,
           Harness::Client::Refused
      run&.destroy
      raise
    end

    def create_run!(base_sha)
      AiRun.create!(
        session: @session,
        status: 'queued',
        requested_by: @requested_by,
        prompt: @prompt,
        model: @model,
        lane: @lane,
        base_sha: base_sha
      )
    end

    # `start_run` raises on anything but 202 (Harness::Client), so reaching the next line
    # means the harness accepted it.
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
        resume_context: resume
      }
    end

    # Omitted rather than sent as nil: the harness treats an absent key as "today's
    # default", so a null would be a different request from no request.
    def optional_payload
      {
        effort: @effort,
        disallowed_tools: @disallowed_tools,
        connectors: @connectors,
        skills: @skills,
        # WHOSE ACCOUNT PAYS. Omitted when unset so the harness uses the host default —
        # an explicit null would be a different request.
        aws_profile: @session.aws_profile
      }.compact_blank
    end
  end
end
