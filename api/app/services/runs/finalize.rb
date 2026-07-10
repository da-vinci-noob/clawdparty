# frozen_string_literal: true

module Runs
  # Drives ai_run state transitions from ingested run-lifecycle events (not by
  # polling). Rails — not the sidecar — owns every transition; the sidecar only
  # emits the events. Invoked from the Events::Ingest path after a durable
  # run-lifecycle event persists.
  #
  #   run_started     → running         (queued → running)
  #   run_finished    → completed_clean (clean tree) | awaiting_review (changeset ready)
  #   run_failed      → failed
  #   run_interrupted → awaiting_review (dirty tree) | completed_clean (clean)
  LIFECYCLE_TYPES = %w[run_started run_finished run_failed run_interrupted changeset_ready].freeze

  class Finalize
    def self.call(event)
      new(event).call
    end

    def initialize(event)
      @event = event
    end

    def call
      return unless LIFECYCLE_TYPES.include?(@event.event_type)

      run = @event.ai_run
      return unless run

      case @event.event_type
      when 'run_started'
        finalize_run_started(run)
      when 'run_finished'
        run.update!(status: finished_status(run))
      when 'run_failed'
        run.update!(status: 'failed')
      when 'run_interrupted'
        run.update!(status: interrupted_status(run))
      when 'changeset_ready'
        run.update!(status: 'awaiting_review')
      end
    end

    private

    # Transition queued → running and capture the Claude session id the sidecar
    # reports in run_started, so a later follow-up can resume that session. Both
    # writes are combined into one update! (payload keys are strings).
    def finalize_run_started(run)
      attrs = {}
      attrs[:status] = 'running' if run.status == 'queued'
      sid = @event.payload['claude_session_id'].presence
      attrs[:claude_session_id] = sid if sid && run.claude_session_id.blank?
      run.update!(attrs) unless attrs.empty?
    end

    # A `chat` run has no changeset to review → always completed_clean. A `review`
    # run enters awaiting_review only when a changeset is ready.
    def finished_status(run)
      return 'completed_clean' if run.session.mode == 'chat'

      changeset_ready?(run) ? 'awaiting_review' : 'completed_clean'
    end

    def interrupted_status(run)
      return 'completed_clean' if run.session.mode == 'chat'

      worktree_dirty?(run) ? 'awaiting_review' : 'completed_clean'
    end

    # A changeset_ready event for this run means there is something to review.
    def changeset_ready?(run)
      run.events.exists?(event_type: 'changeset_ready')
    end

    def worktree_dirty?(run)
      Git::WorktreeManager.new(run.session).dirty?
    rescue Git::WorktreeManager::GitError
      # If the worktree can't be inspected (e.g. not created in a test), treat as
      # clean so finalize is deterministic rather than raising mid-ingest.
      false
    end
  end
end
