# frozen_string_literal: true

# Session-scoped skill discovery for the run/prompt composer. Proxies the
# sidecar's GET /skills (which scans SKILL.md files under the session's repo +
# host ~/.claude) so the "✦ Skills N" count is real, not a literal. Gated on
# participantship (nested under the session); a cross-session/non-participant
# request is 404. Mirrors ModelsController for failure: an unreachable sidecar
# is 502, not a fabricated empty list.
class SkillsController < ApplicationController
  include SidecarDiscovery

  before_action :require_user

  rescue_from Sidecar::Client::TransportError do
    render(json: { errors: [{ message: 'The Claude sidecar is unavailable; try again' }] }, status: :bad_gateway)
  end

  # GET /api/sessions/:session_id/skills
  def index
    session = Session.find_by(id: params[:session_id])
    return render_not_found if session.nil? || participant_for(session).nil?

    render(json: discover_skills(session), status: :ok)
  end
end
