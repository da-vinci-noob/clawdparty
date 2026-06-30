# frozen_string_literal: true

# Chat send (routed under the /api scope). Creates the Message and appends a
# `chat_message` event in ONE transaction via Events::Append (which broadcasts
# it) — chat rides the same store/dedupe/broadcast path as every other event, no
# bespoke cable message. Gated to the `chat` action (all four roles may chat).
class MessagesController < ApplicationController
  before_action :require_user

  # POST /api/sessions/:session_id/messages
  def create
    session = Session.find_by(id: params[:session_id])
    raise(ActiveRecord::RecordNotFound) if session.nil?

    participant = participant_for(session)
    raise(ActiveRecord::RecordNotFound) if participant.nil?

    authorize!(:chat, session)
    body = params.require(:body)

    message = Events::Append.call(
      session: session,
      event: { type: 'chat_message', actor: { kind: 'user', id: participant.id }, payload: { body: body } }
    ) do
      Message.create!(session: session, author: participant, kind: 'user', body: body)
    end

    render(json: { id: message.id.to_s, body: message.body }, status: :created)
  end
end
