# frozen_string_literal: true

require 'rails_helper'

RSpec.describe('GET /api/sessions/:id/participant (re-hydrate from cookie)') do
  let(:session) { create(:session) }

  it 'returns the current participant for a joined user (cookie-authenticated)' do
    participant = join_as(session, role: 'owner')
    get("/api/sessions/#{session.id}/participant")

    expect(response).to(have_http_status(:ok))
    body = response.parsed_body
    expect(body['id']).to(eq(participant.id.to_s))
    expect(body['role']).to(eq('owner'))
    expect(body['session_id']).to(eq(session.id.to_s))
  end

  it 'refuses an unauthenticated request with 404' do
    get("/api/sessions/#{session.id}/participant")
    expect(response).to(have_http_status(:not_found))
  end

  it 'refuses a user who joined a different session with 404 (not a participant here)' do
    other = create(:session)
    join_as(other, role: 'owner') # cookie is for `other`, not `session`
    get("/api/sessions/#{session.id}/participant")
    expect(response).to(have_http_status(:not_found))
  end
end
