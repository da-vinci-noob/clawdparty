# frozen_string_literal: true

module ApplicationCable
  class Connection < ActionCable::Connection::Base
    identified_by :current_user

    def connect
      self.current_user = find_verified_user
    end

    private

    # Resolve the same signed httpOnly `clawd_uid` cookie used by REST.
    def find_verified_user
      uid = cookies.signed[ApplicationController::COOKIE_NAME]
      user = uid && User.find_by(id: uid)
      user || reject_unauthorized_connection
    end
  end
end
