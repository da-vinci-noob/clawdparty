# frozen_string_literal: true

# Mint a role-scoped invite token for a session (owner only). Returns the RAW
# token exactly once — only its SHA-256 digest is stored (Invite.generate!), so
# the owner must copy the shareable link now. SessionPolicy gates this to
# `manage_invites` (owner); a non-participant/unknown session gets 404, a
# participant lacking the role gets 403 (anti-enumeration, via authorize!).
class InvitesController < ApplicationController
  before_action :require_user

  ROLES = %w[owner editor reviewer viewer].freeze

  def create
    session = Session.find_by(id: params[:session_id])
    raise(ActiveRecord::RecordNotFound) if session.nil? || participant_for(session).nil?

    authorize!(:manage_invites, session)
    role = params.require(:role).to_s
    return render_bad_role unless ROLES.include?(role)

    invite, raw = Invite.generate!(session: session, role: role, expires_at: params[:expires_at].presence)
    render(json: { token: raw, role: invite.role, session_id: session.id.to_s }, status: :created)
  end

  private

  def render_bad_role
    render(json: { errors: [{ message: "Role must be one of #{ROLES.join(', ')}" }] },
           status: :unprocessable_content)
  end
end
