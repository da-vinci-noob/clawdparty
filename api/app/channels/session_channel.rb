# frozen_string_literal: true

# The per-session realtime channel mounted at /~cable. Every broadcast is a
# frozen Contract-1 event envelope — never a bespoke cable message. Subscriptions
# independently verify participantship before streaming (the client only hides
# buttons; the server enforces).
class SessionChannel < ApplicationCable::Channel
  def subscribed
    session = Session.find_by(id: params[:session_id])
    return reject unless session && participant?(session)

    stream_for(session)
  end

  private

  def participant?(session)
    current_user && session.participants.exists?(user_id: current_user.id)
  end
end
