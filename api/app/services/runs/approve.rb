# frozen_string_literal: true

module Runs
  # Owner-approves a reviewed changeset: the run must be awaiting_review, then it
  # becomes `approved` and a `changeset_approved` event is appended in the same
  # transaction (via Events::Append, which also broadcasts). The worktree is left
  # exactly as-is — approve keeps Claude's edits.
  class Approve
    class NotReviewable < StandardError; end

    def self.call(**)
      new(**).call
    end

    def initialize(run:, reviewed_by:)
      @run = run
      @reviewed_by = reviewed_by
    end

    def call
      raise(NotReviewable) unless @run.status == 'awaiting_review'

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
