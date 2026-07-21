# frozen_string_literal: true

module Runs
  # Starts a run: enforce one-active-run (the DB partial unique index is the
  # backstop), create the worktree + record base_sha, create the `queued` ai_run,
  # and POST to the sidecar's /runs. It does NOT emit `run_started` — the sidecar
  # emits that (frozen sidecar-protocol), and Rails transitions queued → running
  # when it ingests it (Runs::Finalize). Encodes reject-no-resume / revise-resumes.
  class Start
    class ActiveRunExists < StandardError; end
    class DirtyWorktree < StandardError; end
    class UnsupportedPermissionMode < StandardError; end
    class SessionArchived < StandardError; end

    # The pre-approval base — the 8 built-in tools the composer advertises ON
    # (kept in sync with packages/contracts BUILTIN_TOOLS; Rails can't import TS,
    # so this is the Ruby source of truth). Turning a tool OFF is modeled as
    # `disallowed_tools`, not by shrinking this set (only a bare disallowedTools
    # truly removes a tool — see design D1/D8).
    DEFAULT_ALLOWED_TOOLS = %w[Read Write Edit Bash Glob Grep WebSearch WebFetch].freeze
    # Claude permission modes users may pick (the CLI Shift+Tab modes we support).
    # `default`/`dontAsk`/ask-per-tool are intentionally excluded (no per-tool
    # approval UI). `bypassPermissions` is owner-gated in the controller.
    PERMISSION_MODES = %w[plan acceptEdits bypassPermissions].freeze
    DEFAULT_PERMISSION_MODE = 'acceptEdits'

    Result = Struct.new(:ai_run, :sidecar_status, keyword_init: true)

    def self.call(**)
      new(**).call
    end

    def initialize(session:, requested_by:, prompt:, model:, mode: 'fresh',
                   permission_mode: DEFAULT_PERMISSION_MODE, disallowed_tools: [], connectors: [], skills: [],
                   client: Sidecar::Client.new, worktree: nil)
      @session = session
      @requested_by = requested_by
      @prompt = prompt
      @model = model
      @mode = mode
      @permission_mode = permission_mode
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

      claude_session_id = resume_session_id(revise)
      prior&.update!(status: 'superseded') if revise

      create_and_post!(cwd, claude_session_id)
    rescue ActiveRecord::RecordNotUnique
      # The partial unique index won the race: another active run exists.
      raise(ActiveRunExists)
    end

    private

    # Guards that must hold before any run is created, independent of mode. Archive
    # is a hard close: no new run may start on an archived session — enforced in the
    # service (not just the controller) so the invariant holds for every caller.
    def preflight!
      raise(UnsupportedPermissionMode, "unsupported permission_mode: #{@permission_mode}") unless
        PERMISSION_MODES.include?(@permission_mode)
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

    # Resume the prior Claude session so context persists across runs. `revise`
    # resumes the run being revised; a normal follow-up resumes the most recent
    # prior run's session — EXCEPT a reject severs the chain (the reverted
    # worktree no longer matches that session's context), so a fresh start whose
    # most recent run was rejected begins a new session.
    def resume_session_id(revise)
      last = @session.ai_runs.order(:id).last
      return nil if last.nil?
      return nil if !revise && last.status == 'rejected'

      last.claude_session_id
    end

    # If the sidecar refuses the start, drop the just-created run so no
    # queued/active run is left behind to block the session (queued counts toward
    # one-active-run); re-raise so the controller still surfaces the error.
    def create_and_post!(cwd, claude_session_id)
      run = create_run!
      status = post_to_sidecar(run, cwd, claude_session_id)
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

    def post_to_sidecar(run, cwd, claude_session_id)
      payload = {
        run_id: run.id.to_s,
        session_id: @session.id.to_s,
        repo_path: cwd,
        prompt: @prompt,
        requested_by: @requested_by.id.to_s,
        model: @model,
        permission_mode: @permission_mode,
        allowed_tools: DEFAULT_ALLOWED_TOOLS
      }
      payload[:claude_session_id] = claude_session_id if claude_session_id
      payload[:disallowed_tools] = @disallowed_tools if @disallowed_tools.present?
      payload[:connectors] = @connectors if @connectors.present?
      payload[:skills] = @skills if @skills.present?
      @client.start_run(payload).status
    end
  end
end
