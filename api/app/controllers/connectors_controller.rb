# frozen_string_literal: true

# Session-scoped connector discovery for the run/prompt composer. Proxies the
# sidecar's GET /connectors (which enumerates the MCP servers the host has
# configured for the session's repo) so the web picker only ever shows real,
# host-owned servers — never client-defined ones, never their command/url/env.
# Gated on participantship (nested under the session); a cross-session/non-
# participant request is 404 (anti-enumeration). Mirrors ModelsController for
# failure: an unreachable sidecar is 502, not a fabricated empty list.
class ConnectorsController < ApplicationController
  include SidecarDiscovery

  before_action :require_user

  rescue_from Sidecar::Client::TransportError do
    render(json: { errors: [{ message: 'The Claude sidecar is unavailable; try again' }] }, status: :bad_gateway)
  end

  # GET /api/sessions/:session_id/connectors
  def index
    session = Session.find_by(id: params[:session_id])
    return render_not_found if session.nil? || participant_for(session).nil?

    render(json: discover_connectors(session), status: :ok)
  end
end
