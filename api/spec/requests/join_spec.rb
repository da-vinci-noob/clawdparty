# frozen_string_literal: true

require 'rails_helper'

RSpec.describe('POST /api/participants (join)') do
  let(:session) { create(:session) }

  def generate_invite(role: 'editor', expires_at: nil)
    Invite.generate!(session: session, role: role, expires_at: expires_at)
  end

  it 'issues a participant + signed clawd_uid cookie on a valid join' do
    _, raw = generate_invite(role: 'editor')

    expect do
      post('/api/participants', params: { token: raw, name: 'Alice' })
    end.to(change(Participant, :count).by(1))

    expect(response).to(have_http_status(:created))
    expect(response.parsed_body['role']).to(eq('editor'))
    expect(response.headers['Set-Cookie']).to(include('clawd_uid'))
    expect(response.headers['Set-Cookie']).not_to(include('secure'))
  end

  it "ignores a client-supplied role param and uses the invite's role" do
    _, raw = generate_invite(role: 'viewer')
    post('/api/participants', params: { token: raw, name: 'Mallory', role: 'owner' })
    expect(response.parsed_body['role']).to(eq('viewer'))
    expect(Participant.last.role).to(eq('viewer'))
  end

  it 'refuses an expired invite with 404 and creates no participant' do
    _, raw = generate_invite(expires_at: 1.hour.ago)
    expect do
      post('/api/participants', params: { token: raw, name: 'Bob' })
    end.not_to(change(Participant, :count))
    expect(response).to(have_http_status(:not_found))
  end

  it 'refuses a revoked invite with 404' do
    invite, raw = generate_invite
    invite.revoke!
    post('/api/participants', params: { token: raw, name: 'Bob' })
    expect(response).to(have_http_status(:not_found))
  end

  it 'refuses an unknown token with 404 (indistinguishable from expired/revoked)' do
    post('/api/participants', params: { token: 'nope', name: 'Bob' })
    expect(response).to(have_http_status(:not_found))
  end

  it 'refuses a blank display name with 422' do
    _, raw = generate_invite
    expect do
      post('/api/participants', params: { token: raw, name: '  ' })
    end.not_to(change(Participant, :count))
    expect(response).to(have_http_status(:unprocessable_content))
  end

  it 'creates a distinct Participant per join even when the User is reused' do
    _, raw1 = generate_invite
    _, raw2 = generate_invite
    post('/api/participants', params: { token: raw1, name: 'Sam' })
    first_id = response.parsed_body['id']
    post('/api/participants', params: { token: raw2, name: 'Sam' })
    second_id = response.parsed_body['id']

    expect(first_id).not_to(eq(second_id))
    expect(User.where(name: 'Sam').count).to(eq(1))
  end
end
