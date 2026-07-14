# frozen_string_literal: true

module Runs
  # Owner-approves a reviewed changeset: the run must be awaiting_review, then the
  # accepted changeset is COMMITTED onto the session worktree branch (keeps
  # Claude's edits AND leaves a clean tree so the next fresh run is not blocked
  # as dirty), and the run becomes `approved` with a `changeset_approved` event
  # appended in the same transaction (via Events::Append, which also broadcasts).
  class Approve
    class NotReviewable < StandardError; end

    def self.call(**)
      new(**).call
    end

    def initialize(run:, reviewed_by:, worktree: nil)
      @run = run
      @reviewed_by = reviewed_by
      @worktree = worktree || Git::WorktreeManager.new(run.session)
    end

    def call
      raise(NotReviewable) unless @run.status == 'awaiting_review'

      @worktree.commit!("clawdparty: approved changeset for run #{@run.id}")
      Events::Append.call(
        session: @run.session,
        event: {
          type: 'changeset_approved',
          actor: { kind: 'user', id: @reviewed_by.id },
          ai_run_id: @run.id,
          seq: (@run.events.maximum(:seq) || 0) + 1,
          payload: {}
        }
      ) { @run.update!(status: 'approved', reviewed_by: @reviewed_by) }
      @run
    end
  end
end
