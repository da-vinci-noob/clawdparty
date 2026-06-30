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

    DEFAULT_ALLOWED_TOOLS = %w[Read Write Edit Bash].freeze

    Result = Struct.new(:ai_run, :sidecar_status, keyword_init: true)

    def self.call(**)
      new(**).call
    end

    def initialize(session:, requested_by:, prompt:, model:, mode: 'fresh',
                   client: Sidecar::Client.new, worktree: nil)
      @session = session
      @requested_by = requested_by
      @prompt = prompt
      @model = model
      @mode = mode
      @client = client
      @worktree = worktree || Git::WorktreeManager.new(session)
    end

    def call
      revise = @mode == 'revise'
      prior = @session.ai_runs.active.first
      raise(ActiveRunExists) if prior && !revise

      worktree_path = @worktree.ensure_worktree!
      raise(DirtyWorktree) if !revise && @worktree.dirty?

      claude_session_id = resume_session_id(revise)
      prior&.update!(status: 'superseded') if revise

      create_and_post!(worktree_path, claude_session_id)
    rescue ActiveRecord::RecordNotUnique
      # The partial unique index won the race: another active run exists.
      raise(ActiveRunExists)
    end

    private

    # Reject severs chaining: only a `revise` resumes the prior Claude session. A
    # fresh start (incl. one after a reject) passes NO claude_session_id, so a new
    # session begins against the (reverted) worktree.
    def resume_session_id(revise)
      return nil unless revise

      @session.ai_runs.where.not(claude_session_id: nil).order(:id).last&.claude_session_id
    end

    # If the sidecar refuses the start, drop the just-created run so no
    # queued/active run is left behind to block the session (queued counts toward
    # one-active-run); re-raise so the controller still surfaces the error.
    def create_and_post!(worktree_path, claude_session_id)
      run = create_run!(worktree_path)
      status = post_to_sidecar(run, worktree_path, claude_session_id)
      Result.new(ai_run: run, sidecar_status: status)
    rescue Sidecar::Client::ActiveRunConflict, Sidecar::Client::TransportError
      run&.destroy
      raise
    end

    def create_run!(_worktree_path)
      AiRun.create!(
        session: @session,
        status: 'queued',
        requested_by: @requested_by,
        prompt: @prompt,
        model: @model
      )
    end

    def post_to_sidecar(run, worktree_path, claude_session_id)
      payload = {
        run_id: run.id.to_s,
        session_id: @session.id.to_s,
        repo_path: worktree_path,
        prompt: @prompt,
        requested_by: @requested_by.id.to_s,
        model: @model,
        permission_mode: 'acceptEdits',
        allowed_tools: DEFAULT_ALLOWED_TOOLS
      }
      payload[:claude_session_id] = claude_session_id if claude_session_id
      @client.start_run(payload).status
    end
  end
end
