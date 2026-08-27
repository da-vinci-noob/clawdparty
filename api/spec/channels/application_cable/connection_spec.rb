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

  # A RECONNECT whose identity has stopped working. The established-cookie cases above are
  # the happy path; these are what happens after it breaks mid-session, and the rule is that a
  # reconnect REFUSES rather than attaching with no identity. A connection with a null
  # `current_user` would stream to someone the server cannot name.
  describe 'an identity that stops working mid-session' do
    it 'rejects a reconnect once the cookie is gone' do
      cookies.signed[ApplicationController::COOKIE_NAME] = user.id
      connect('/~cable')
      expect(connection.current_user).to(eq(user))

      # The browser cleared it, or it expired, and the client reconnects. Cleared through the
      # SIGNED jar: measured, a channel spec keeps signed and raw values separately, so assigning
      # '' to the raw name leaves `cookies.signed` still reading the old id.
      cookies.signed[ApplicationController::COOKIE_NAME] = nil
      expect { connect('/~cable') }.to(have_rejected_connection)
    end

    it 'rejects a cookie signed for a user that no longer exists' do
      cookies.signed[ApplicationController::COOKIE_NAME] = user.id
      user.destroy!

      # The signature still verifies — it is the LOOKUP that fails. Trusting the signature alone
      # would attach a connection for a deleted account.
      expect { connect('/~cable') }.to(have_rejected_connection)
    end

    it 'rejects an unparseable cookie rather than reading it as an id' do
      cookies[ApplicationController::COOKIE_NAME] = 'not-a-number'
      expect { connect('/~cable') }.to(have_rejected_connection)
    end

    it 'never attaches a connection with a null current_user' do
      # The property behind all of the above: `find_verified_user` either returns a user or rejects.
      # A silent downgrade — connected, identified as nobody — is the failure mode being excluded,
      # because `SessionChannel`'s participantship check would then be asked about a nil user and
      # would answer for one.
      cookies.signed[ApplicationController::COOKIE_NAME] = nil

      expect { connect('/~cable') }.to(have_rejected_connection)
    end
  end
end
