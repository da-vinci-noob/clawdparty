# frozen_string_literal: true

# Session-scoped extension management.
#
# `index` is readable by ANY participant, because which rules are in force is a fact about the room:
# a `tool:before` gate decides what Claude may do, and a viewer watching a refusal should be able to
# see which rule refused it. `update` is owner-only (`manage_session`, the same gate as invites,
# archive and skills) for the same reason skills are — turning a gate off changes what the room can
# do, which is closer to granting a capability than to editing a setting.
#
# BUNDLED CONTRIBUTORS ONLY. There is no install endpoint, and that is a decision rather than an
# omission: a measurement showed that a `worker_thread` with `env: {}` isolates the environment and
# nothing else — code inside one reads any file the harness user can read, spawns processes, and
# reaches the network — so  cannot be delivered by that mechanism. Third-party loading is
# therefore not built, and  holds by construction.
#
# The harness owns the RECORD (the `session.plugins` register) and this controller owns the EVENT,
# which is the same split `skills_controller` uses and for the same structural reason: the harness
# allocates per-run `seq` and a plugin toggle belongs to no run.
class PluginsController < ApplicationController
  include HarnessDiscovery

  before_action :require_user

  rescue_from Harness::Client::TransportError do
    render(json: { errors: [{ message: 'The harness is unavailable; try again' }] }, status: :bad_gateway)
  end

  # GET /api/sessions/:session_id/plugins
  def index
    session = Session.find_by(id: params[:session_id])
    raise(ActiveRecord::RecordNotFound) if session.nil?

    authorize!(:view, session)
    render(json: Harness::Client.new.list_plugins(session.id.to_s).body, status: :ok)
  end

  # PATCH /api/sessions/:session_id/plugins/:id — enable or disable one.
  #
  # A PATCH rather than POST/DELETE pair: the resource is the plugin's enablement for this session,
  # and it is a boolean being set, not a thing being created or destroyed.
  def update
    session = Session.find_by(id: params[:session_id])
    raise(ActiveRecord::RecordNotFound) if session.nil?

    authorize!(:manage_session, session)
    return render_bad_request if enabled_param.nil?

    apply!(session)
  end

  private

  # Only an explicit boolean. A missing or unparseable value is refused rather than defaulting,
  # because either default silently does the opposite of what half of callers meant.
  def enabled_param
    value = params[:enabled]
    return true if [true, 'true'].include?(value)
    return false if [false, 'false'].include?(value)

    nil
  end

  def apply!(session)
    result = Harness::Client.new.set_plugin_enabled(
      session.id.to_s, plugin_id: params[:id], enabled: enabled_param
    )
    return render_refusal(result) unless result.status == 200

    record_change(session, active: Array(result.body['active']))
    render(json: { id: params[:id], enabled: enabled_param, active: result.body['active'] }, status: :ok)
  end

  # enablement is "an explicit, attributable action", so it lands in the session's timeline
  # with the participant who did it — not only in a register nobody reads. The RESOLVED set rides
  # along so a late joiner learns the state from the event rather than having to fetch it.
  def record_change(session, active:)
    Events::Append.call(
      session: session,
      event: {
        type: enabled_param ? 'plugin_enabled' : 'plugin_disabled',
        actor: { kind: 'user', id: participant_for(session).id },
        payload: { id: params[:id], active: active }
      }
    )
  end

  def render_refusal(result)
    message = result.body['message'].presence || 'The extension could not be changed'
    render(json: { errors: [{ message: message }] }, status: :unprocessable_content)
  end

  def render_bad_request
    render(json: { errors: [{ message: '`enabled` must be true or false' }] }, status: :bad_request)
  end
end
