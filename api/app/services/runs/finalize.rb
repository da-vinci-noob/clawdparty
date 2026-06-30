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
        run.update!(status: 'running') if run.status == 'queued'
      when 'run_finished'
        run.update!(status: changeset_ready?(run) ? 'awaiting_review' : 'completed_clean')
      when 'run_failed'
        run.update!(status: 'failed')
      when 'run_interrupted'
        run.update!(status: worktree_dirty?(run) ? 'awaiting_review' : 'completed_clean')
      when 'changeset_ready'
        run.update!(status: 'awaiting_review')
      end
    end

    private

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
