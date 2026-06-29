# frozen_string_literal: true

require 'rails_helper'

RSpec.describe(SessionChannel) do
  let(:session) { create(:session) }
  let(:participant) { create(:participant, session: session) }

  it 'streams for a participant of the session' do
    stub_connection(current_user: participant.user)
    subscribe(session_id: session.id)

    expect(subscription).to(be_confirmed)
    expect(subscription).to(have_stream_for(session))
  end

  it 'rejects a subscription from a non-participant' do
    outsider = create(:user)
    stub_connection(current_user: outsider)
    subscribe(session_id: session.id)

    expect(subscription).to(be_rejected)
  end

  it 'rejects a subscription to an unknown session' do
    stub_connection(current_user: participant.user)
    subscribe(session_id: -1)

    expect(subscription).to(be_rejected)
  end
end
