# frozen_string_literal: true

module Harness
  # Fails runs the harness has stopped reporting, so a harness crash cannot leave a
  # session permanently blocked by index_ai_runs_one_active_per_session.
  class HealthcheckJob < ApplicationJob
    queue_as :default

    # awaiting_review is excluded despite being in AiRun::ACTIVE_STATUSES: the harness
    # has already finished it, so sweeping would destroy a pending human review.
    SWEEPABLE_STATUSES = %w[queued running].freeze
    STALE_AFTER = 15.seconds

    def perform
      stale_runs.each { |run| fail_run(run) }
    end

    private

    # A NULL heartbeat means the harness has not acknowledged the run yet, so fall back
    # to created_at — otherwise a run would be failed in the gap before its first beat.
    def stale_runs
      AiRun
        .where(status: SWEEPABLE_STATUSES)
        .where('COALESCE(ai_runs.last_heartbeat_at, ai_runs.created_at) < ?', STALE_AFTER.ago)
    end

    def fail_run(run)
      Events::Append.call(
        session: run.session,
        event: {
          type: 'run_failed',
          actor: { kind: 'system' },
          ai_run_id: run.id,
          seq: (run.events.maximum(:seq) || 0) + 1,
          payload: {
            stop_reason: 'harness_unreachable',
            api_error_status: nil,
            total_cost_usd: run.total_cost_usd || 0,
            usage: run.usage || {}
          }
        }
      ) { run.update!(status: 'failed') }
    end
  end
end
