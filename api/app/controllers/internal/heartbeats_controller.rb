# frozen_string_literal: true

module Internal
  # Thin ack-only heartbeat receiver. The sidecar POSTs every 5s and treats a
  # 404 as FATAL, so this route must exist in W1. The stale-run reconciliation
  # (Sidecar::HealthcheckJob) is a W2 change layered on top — W1 does nothing
  # with the body beyond acknowledging it.
  class HeartbeatsController < BaseController
    def create
      render(json: { ok: true }, status: :ok)
    end
  end
end
