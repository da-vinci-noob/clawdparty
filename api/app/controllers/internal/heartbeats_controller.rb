# frozen_string_literal: true

module Internal
  # Heartbeat receiver. The harness POSTs every 5s with the run ids it still holds in
  # memory; those runs get their liveness stamp refreshed. A run the harness does NOT
  # name is left untouched so it ages out via Harness::HealthcheckJob — that is how a
  # harness restart, which loses in-memory run state, releases the session.
  class HeartbeatsController < BaseController
    def create
      touch_active_runs
      record_store_cursors
      render(json: { ok: true }, status: :ok)
    end

    private

    def touch_active_runs
      ids = Array(params[:active_run_ids]).map(&:to_s).grep(/\A\d+\z/)
      return if ids.empty?

      AiRun.where(id: ids, status: Harness::HealthcheckJob::SWEEPABLE_STATUSES)
           .update_all(last_heartbeat_at: Time.current) # rubocop:disable Rails/SkipsModelValidations
    end

    # PROJECTION LAG, every 5s. `Harness::Reconcile` already records this at boot,
    # which answers "how far behind was I when I started" and nothing about the next hour.
    # Comparing it to `MAX(events.store_seq)` for the run is how lag becomes visible without
    # polling the harness for it.
    #
    # Numeric-id filtered like `active_run_ids`: the harness's run ids ARE Rails ids, so a
    # non-numeric one means the two disagree about what a run is, and coercing it with
    # `to_i` would write the cursor onto run 0 or onto an unrelated row.
    def record_store_cursors
      reported = params[:store_seq_high_water]
      return unless reported.respond_to?(:each_pair)

      reported.each_pair do |run_id, store_seq|
        next unless run_id.to_s.match?(/\A\d+\z/) && store_seq.present?

        AiRun.where(id: run_id.to_s)
             .update_all(harness_store_seq: store_seq.to_i) # rubocop:disable Rails/SkipsModelValidations
      end
    end
  end
end
