# frozen_string_literal: true

# Invite management for a session, owner-gated by `manage_invites` (SessionPolicy).
# A non-participant/unknown session gets 404, a participant lacking the role gets
# 403 (anti-enumeration, via authorize!).
#
# - create: mint a role-scoped token. Returns the RAW token exactly once — only its
#   SHA-256 digest is stored (Invite.generate!), so the owner must copy the link now.
# - index:  list the session's invites (metadata + derived status only, never token
#   material — the raw token is unrecoverable, so links are never re-displayed).
# - destroy: revoke an invite (idempotent). Takes effect immediately because the join
#   flow already refuses any non-usable? invite.
class InvitesController < ApplicationController
  before_action :require_user

  ROLES = %w[owner editor reviewer viewer].freeze

  def index
    authorize!(:manage_invites, session)
    render(json: session.invites.order(:created_at).map { |invite| serialize(invite) })
  end

  def create
    authorize!(:manage_invites, session)
    role = params.require(:role).to_s
    return render_bad_role unless ROLES.include?(role)

    invite, raw = Invite.generate!(session: session, role: role, expires_at: params[:expires_at].presence)
    render(json: { id: invite.id.to_s, token: raw, role: invite.role, session_id: session.id.to_s },
           status: :created)
  end

  def destroy
    authorize!(:manage_invites, session)
    invite = session.invites.find_by(id: params[:id])
    raise(ActiveRecord::RecordNotFound) if invite.nil?

    invite.revoke!
    head(:no_content)
  end

  private

  # Target session, memoized; unknown session => 404 (anti-enumeration), never 403.
  def session
    @session ||= Session.find_by(id: params[:session_id]) || raise(ActiveRecord::RecordNotFound)
  end

  def serialize(invite)
    {
      id: invite.id.to_s,
      role: invite.role,
      created_at: invite.created_at.iso8601,
      expires_at: invite.expires_at&.iso8601,
      status: invite_status(invite)
    }
  end

  # Derived server-side; revoked wins over expired (matches Invite#usable?).
  def invite_status(invite)
    return 'revoked' if invite.revoked?
    return 'expired' if invite.expired?

    'active'
  end

  def render_bad_role
    render(json: { errors: [{ message: "Role must be one of #{ROLES.join(', ')}" }] },
           status: :unprocessable_content)
  end
end
