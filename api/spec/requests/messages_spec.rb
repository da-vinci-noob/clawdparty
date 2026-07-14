# frozen_string_literal: true

require 'rails_helper'

RSpec.describe('Chat messages') do
  let(:session) { create(:session) }

  def send_chat(body: 'hello team')
    post("/api/sessions/#{session.id}/messages", params: { body: body })
  end

  %w[owner editor reviewer viewer].each do |role|
    it "allows #{role} to chat (all roles may chat)" do
      join_as(session, role: role)
      expect { send_chat }.to(change(Message, :count).by(1).and(change(Event, :count).by(1)))
      expect(response).to(have_http_status(:created))
    end
  end

  it 'appends a chat_message event (not a bespoke message), user-attributed, session-scoped' do
    participant = join_as(session, role: 'editor')
    send_chat(body: 'ship it')
    ev = Event.where(event_type: 'chat_message').last
    expect(ev.actor_kind).to(eq('user'))
    expect(ev.actor_participant_id).to(eq(participant.id))
    expect(ev.ai_run_id).to(be_nil) # session-scoped
    expect(ev.seq).to(be_nil)
    expect(ev.payload['body']).to(eq('ship it'))
  end

  it 'refuses a non-participant with 404 (not 403)' do
    other = create(:session)
    join_as(session, role: 'owner')
    post("/api/sessions/#{other.id}/messages", params: { body: 'hi' })
    expect(response).to(have_http_status(:not_found))
  end

  it 'requires authentication (404 without a cookie)' do
    send_chat
    expect(response).to(have_http_status(:not_found))
  end
end
