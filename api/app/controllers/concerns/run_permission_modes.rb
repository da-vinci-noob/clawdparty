# frozen_string_literal: true

# Permission-mode selection for run control (claude-permission-modes): validate the
# requested Claude permission mode against the allowlist, gate `bypassPermissions`
# to owners, and expose the mid-run switch endpoint (plan → execute). Kept in a
# concern so RunsController stays focused on the core run lifecycle.
module RunPermissionModes
  extend ActiveSupport::Concern

  included do
    rescue_from Runs::Start::UnsupportedPermissionMode do
      render(json: { errors: [{ message: bad_permission_mode_message }] }, status: :unprocessable_content)
    end
    rescue_from Sidecar::Client::RunNotActive do
      render(json: { errors: [{ message: 'Run is no longer active; start a fresh run to execute' }] },
             status: :conflict)
    end
  end

  # POST /api/runs/:id/permission_mode — switch the active run's Claude permission
  # mode in-session (the plan→execute flow). Role-gated like run; bypass owner-only.
  # 409 (RunNotActive) when the run has ended → the client falls back to a fresh run.
  def permission_mode
    run = find_run!
    participant = authorize_action!(:run, run.session)
    mode = validated_permission_mode!(params.require(:permission_mode), run.session)
    Sidecar::Client.new.set_permission_mode(run.id, permission_mode: mode, requested_by: participant.id.to_s)
    render(json: { run_id: run.id.to_s, permission_mode: mode }, status: :ok)
  end

  private

  # Resolve the run-start permission mode: default acceptEdits, validated against
  # the allowlist (422 via UnsupportedPermissionMode), bypass owner-gated (403).
  def permission_mode_param(session)
    validated_permission_mode!(params[:permission_mode].presence || Runs::Start::DEFAULT_PERMISSION_MODE, session)
  end

  def validated_permission_mode!(mode, session)
    raise(Runs::Start::UnsupportedPermissionMode) unless Runs::Start::PERMISSION_MODES.include?(mode)

    authorize!(:bypass_permissions, session) if mode == 'bypassPermissions'
    mode
  end

  def bad_permission_mode_message
    "permission_mode must be one of #{Runs::Start::PERMISSION_MODES.join(', ')}"
  end
end
