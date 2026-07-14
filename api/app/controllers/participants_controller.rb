# frozen_string_literal: true

# Join a session by exchanging a valid invite token for a signed httpOnly
# `clawd_uid` cookie. The role comes solely from the invite — any client-
# supplied role param is ignored. (Routed under the /api path scope.)
class ParticipantsController < ApplicationController
  # GET /api/sessions/:session_id/participant — resolve the current participant
  # (role/name) for this session from the signed clawd_uid cookie, so the client
  # can re-hydrate role-gated UI after a page refresh (the in-memory store is lost;
  # the cookie is not). 404 if there is no cookie or the user is not a participant
  # (anti-enumeration — same as a cross-session request).
  def show
    session = Session.find_by(id: params[:session_id])
    participant = session && participant_for(session)
    return render_not_found if participant.nil?

    render(json: participant_json(participant), status: :ok)
  end

  def create
    invite = find_usable_invite
    return render_not_found if invite.nil? # invalid/expired/revoked — indistinguishable

    name = params[:name].to_s.strip
    return render_blank_name if name.empty?

    participant = join!(invite, name)
    announce_participant_joined(participant)
    cookies.signed[COOKIE_NAME] = cookie_options(participant.user_id)
    render(json: participant_json(participant), status: :created)
  end

  private

  # A DISTINCT participant per join (even when the User is reused), so each
  # participant id — what actor.id carries — stays unique per join.
  def join!(invite, name)
    ActiveRecord::Base.transaction do
      user = User.find_or_create_by!(name: name)
      Participant.create!(session: invite.session, user: user, role: invite.role)
    end
  end

  def find_usable_invite
    token = params[:token].to_s
    return nil if token.empty?

    invite = Invite.find_by(token_digest: Invite.digest_for(token))
    invite if invite&.usable?
  end

  def cookie_options(user_id)
    # No Secure flag — the LAN is plain HTTP (documented accepted MVP risk).
    { value: user_id, httponly: true, same_site: :lax }
  end

  def participant_json(participant)
    {
      id: participant.id.to_s,
      session_id: participant.session_id.to_s,
      role: participant.role,
      name: participant.user.name
    }
  end

  def render_blank_name
    render(json: { errors: [{ message: "Name can't be blank" }] }, status: :unprocessable_content)
  end
end
