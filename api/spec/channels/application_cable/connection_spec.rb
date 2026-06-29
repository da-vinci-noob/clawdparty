# frozen_string_literal: true

require 'rails_helper'

RSpec.describe(ApplicationCable::Connection) do
  let(:user) { create(:user) }

  it 'accepts a connection bearing the signed clawd_uid cookie' do
    cookies.signed[ApplicationController::COOKIE_NAME] = user.id
    connect '/~cable'
    expect(connection.current_user).to(eq(user))
  end

  it 'rejects a connection with no clawd_uid cookie' do
    expect { connect('/~cable') }.to(have_rejected_connection)
  end

  it 'rejects a connection with a forged (unsigned) cookie' do
    cookies[ApplicationController::COOKIE_NAME] = '999'
    expect { connect('/~cable') }.to(have_rejected_connection)
  end
end
