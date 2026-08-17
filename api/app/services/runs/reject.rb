# frozen_string_literal: true

module Runs
  # Owner-rejects a reviewed changeset: the run must be awaiting_review, then the
  # worktree is reverted (`git reset --hard HEAD && git clean -fd`), the run
  # becomes `rejected`, and a `changeset_rejected` event is appended in the same
  # transaction (via Events::Append, which also broadcasts). Reject-severs the
  # Claude-session chain — that rule lives in Runs::Start (a fresh run after a
  # reject does not resume), so it is NOT duplicated here.
  class Reject
    class NotReviewable < StandardError; end

    def self.call(**)
      new(**).call
    end

    def initialize(run:, reviewed_by:, worktree: nil)
      @run = run
      @reviewed_by = reviewed_by
      # The RUN's lane. This one is the dangerous direction: reject runs `reset --hard` +
      # `clean -fd`, so resolving the wrong worktree would DESTROY another lane's unreviewed
      # work — which is the reason per-lane trees were chosen at all.
      @worktree = worktree || Git::WorktreeManager.new(run.session, lane: run.lane)
    end

    def call
      raise(NotReviewable) unless @run.status == 'awaiting_review'

      @worktree.reset_hard!
      Events::Append.call(
        session: @run.session,
        event: {
          type: 'changeset_rejected',
          actor: { kind: 'user', id: @reviewed_by.id },
          ai_run_id: @run.id,
          seq: (@run.events.maximum(:seq) || 0) + 1,
          payload: {}
        }
      ) { @run.update!(status: 'rejected', reviewed_by: @reviewed_by) }
      @run
    end
  end
end
