# frozen_string_literal: true

module Internal
  # Heartbeat receiver. The harness POSTs every 5s with the run ids it still holds in
  # memory; those runs get their liveness stamp refreshed. A run the harness does NOT
  # name is left untouched so it ages out via Harness::HealthcheckJob — that is how a
  # harness restart, which loses in-memory run state, releases the session.
  class HeartbeatsController < BaseController
    def create
      touch_active_runs
      render(json: { ok: true }, status: :ok)
    end

    private

    def touch_active_runs
      ids = Array(params[:active_run_ids]).map(&:to_s).grep(/\A\d+\z/)
      return if ids.empty?

      AiRun.where(id: ids, status: Harness::HealthcheckJob::SWEEPABLE_STATUSES)
           .update_all(last_heartbeat_at: Time.current) # rubocop:disable Rails/SkipsModelValidations
    end
  end
end
