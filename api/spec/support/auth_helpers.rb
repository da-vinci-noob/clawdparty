# frozen_string_literal: true

module AuthHelpers
  # Join via a real invite so the signed clawd_uid cookie is set on the session,
  # then return the created participant. Subsequent requests in the same example
  # reuse the cookie jar automatically.
  def join_as(session, role: 'editor', name: 'Tester')
    _, raw = Invite.generate!(session: session, role: role)
    post('/api/participants', params: { token: raw, name: name })
    Participant.find(response.parsed_body['id'])
  end
end

RSpec.configure do |config|
  config.include(AuthHelpers, type: :request)
end
