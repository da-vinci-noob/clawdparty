# frozen_string_literal: true

require 'rails_helper'

RSpec.describe('POST /api/sessions/:id/archive (owner hard-close)') do
  let(:session) { create(:session, status: 'active') }

  it 'lets an owner archive an active session (200 + status archived)' do
    join_as(session, role: 'owner')
    post("/api/sessions/#{session.id}/archive")

    expect(response).to(have_http_status(:ok))
    expect(response.parsed_body).to(include('id' => session.id.to_s, 'status' => 'archived'))
    expect(session.reload.status).to(eq('archived'))
  end

  it 'is idempotent: archiving an already-archived session is a 200 no-op' do
    session.update!(status: 'archived')
    join_as(session, role: 'owner')
    post("/api/sessions/#{session.id}/archive")

    expect(response).to(have_http_status(:ok))
    expect(response.parsed_body['status']).to(eq('archived'))
  end

  it 'refuses a non-owner participant with 403 and leaves the status unchanged' do
    join_as(session, role: 'editor')
    post("/api/sessions/#{session.id}/archive")

    expect(response).to(have_http_status(:forbidden))
    expect(session.reload.status).to(eq('active'))
  end

  it 'refuses a participant of another session with 404 (anti-enumeration)' do
    other = create(:session)
    join_as(other, role: 'owner')
    post("/api/sessions/#{session.id}/archive")

    expect(response).to(have_http_status(:not_found))
    expect(session.reload.status).to(eq('active'))
  end

  it 'refuses an unauthenticated request with 404' do
    post("/api/sessions/#{session.id}/archive")
    expect(response).to(have_http_status(:not_found))
  end
end
