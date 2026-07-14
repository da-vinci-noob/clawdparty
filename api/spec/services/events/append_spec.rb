# frozen_string_literal: true

require 'rails_helper'

RSpec.describe(Events::Append) do
  let(:session) { create(:session) }
  let(:participant) { create(:participant, session: session) }

  it 'commits a mutation and its event in one transaction and broadcasts' do
    expect do
      described_class.call(
        session: session,
        event: { type: 'chat_message', actor: { kind: 'user', id: participant.id } }
      ) do
        Message.create!(session: session, author: participant, kind: 'user', body: 'hi')
      end
    end.to(change(Message, :count).by(1).and(change(Event, :count).by(1)))
  end

  it 'rolls back BOTH the mutation and the event if the event insert fails' do
    messages_before = Message.count
    events_before = Event.count

    expect do
      described_class.call(
        session: session,
        # actor_kind user without a participant id violates the check constraint
        event: { type: 'chat_message', actor: { kind: 'user' } }
      ) do
        Message.create!(session: session, author: participant, kind: 'user', body: 'hi')
      end
    end.to(raise_error(ActiveRecord::StatementInvalid))

    expect(Message.count).to(eq(messages_before))
    expect(Event.count).to(eq(events_before))
  end

  it 'broadcasts the appended event' do
    expect do
      described_class.call(
        session: session,
        event: { type: 'chat_message', actor: { kind: 'user', id: participant.id } }
      ) { Message.create!(session: session, author: participant, kind: 'user', body: 'hi') }
    end.to(have_broadcasted_to(session).from_channel(SessionChannel))
  end
end
