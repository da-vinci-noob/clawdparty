# frozen_string_literal: true

# Session-scoped skill discovery and MANAGEMENT.
#
# Discovery (`index`) proxies the harness's GET /skills so the "✦ Skills N" count is real; any
# participant may read it. Management (`create` / `destroy`) is the settings surface's write half,
# and it is different in kind from everything else this app writes:
#
#   * It writes OUTSIDE the session worktree — the session repo's `.claude/skills`, or the host's.
#   * A skill is INSTRUCTIONS CLAUDE WILL FOLLOW, so adding one is closer to granting a capability
#     than to editing a document. Hence owner-only (`manage_session`, the same gate as invites and
#     archive) and an appended `skill_changed` event: who changed the room's capabilities, and when,
#     belongs in its timeline rather than only in a file's mtime.
#
# The harness does the writing (it owns host files and validates the name as a strict single
# segment before touching disk); this controller authorizes, records, and translates its refusal
# into a message a browser can show.
class SkillsController < ApplicationController
  include HarnessDiscovery

  before_action :require_user

  rescue_from Harness::Client::TransportError do
    render(json: { errors: [{ message: 'The harness is unavailable; try again' }] }, status: :bad_gateway)
  end

  # A refused write, in words a participant can act on. The harness reports a machine reason;
  # translating it here keeps the vocabulary out of the browser and the phrasing in one place.
  REFUSALS = {
    'invalid_name' => 'Use a short lowercase name with hyphens, e.g. deploy-notes',
    'exists' => 'A skill with that name already exists — replace it explicitly to overwrite',
    'not_found' => 'That skill is not in this scope'
  }.freeze

  # GET /api/sessions/:session_id/skills
  def index
    session = Session.find_by(id: params[:session_id])
    return render_not_found if session.nil? || participant_for(session).nil?

    render(json: discover_skills(session), status: :ok)
  end

  # POST /api/sessions/:session_id/skills
  def create
    session = authorized_session!
    result = Harness::Client.new.add_skill(**write_params(session))
    return render_refusal(result) unless result.status == 200

    record_change(session, action: params[:replace] ? 'replaced' : 'added')
    render(json: result.body, status: :created)
  end

  # DELETE /api/sessions/:session_id/skills/:id
  #
  # `:id` is the skill NAME. A DELETE that does not delete: the harness renames the directory aside,
  # so an unwanted removal is recoverable — the precedent is `bin/harness reset-session`.
  def destroy
    session = authorized_session!
    result = Harness::Client.new.remove_skill(cwd: session.repository_path.to_s,
                                              scope: scope_param, name: params[:id].to_s)
    return render_refusal(result) unless result.status == 200

    record_change(session, action: 'removed', moved_to: File.basename(result.body['path'].to_s))
    render(json: result.body, status: :ok)
  end

  private

  def authorized_session!
    session = Session.find_by(id: params[:session_id])
    raise(ActiveRecord::RecordNotFound) if session.nil? || participant_for(session).nil?

    # Owner-only. A skill changes what every future run in this room can do.
    authorize!(:manage_session, session)
    session
  end

  def write_params(session)
    { cwd: session.repository_path.to_s, scope: scope_param, name: params[:name].to_s,
      description: params[:description].to_s, body: params[:body].to_s,
      replace: params[:replace] == true }
  end

  # `project` unless `host` is asked for explicitly: a host skill reaches every session on the
  # machine (and the developer's own terminal Claude Code), so it is never the fallback.
  def scope_param
    params[:scope] == 'host' ? 'host' : 'project'
  end

  def record_change(session, action:, moved_to: nil)
    payload = { action: action, name: params[:name].presence || params[:id], scope: scope_param }
    payload[:moved_to] = moved_to if moved_to.present?
    Events::Append.call(
      session: session,
      event: { type: 'skill_changed',
               actor: { kind: 'user', id: participant_for(session).id },
               payload: payload }
    )
  end

  def render_refusal(result)
    reason = result.body['error'].to_s
    message = REFUSALS.fetch(reason, "The skill could not be written (#{reason})")
    render(json: { errors: [{ message: message }] }, status: result.status == 404 ? :not_found : :unprocessable_content)
  end
end
