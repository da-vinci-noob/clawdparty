# frozen_string_literal: true

require 'rails_helper'

RSpec.describe('POST /api/sessions/:id/invites (mint invite)') do
  let(:session) { create(:session) }

  def mint(role: 'editor')
    post("/api/sessions/#{session.id}/invites", params: { role: role })
  end

  it 'lets an owner mint a role-scoped token (201) that is usable to join' do
    join_as(session, role: 'owner')
    expect { mint(role: 'reviewer') }.to(change(Invite, :count).by(1))
    expect(response).to(have_http_status(:created))

    body = response.parsed_body
    expect(body['role']).to(eq('reviewer'))
    expect(body['token']).to(be_present)
    # The raw token resolves to the created invite (only its digest is stored).
    expect(Invite.find_by(token_digest: Invite.digest_for(body['token'])).role).to(eq('reviewer'))
  end

  %w[editor reviewer viewer].each do |role|
    it "denies a #{role} with 403 (owner-only)" do
      join_as(session, role: role)
      expect { mint }.not_to(change(Invite, :count))
      expect(response).to(have_http_status(:forbidden))
    end
  end

  it 'refuses an unknown role with 422' do
    join_as(session, role: 'owner')
    expect { mint(role: 'superuser') }.not_to(change(Invite, :count))
    expect(response).to(have_http_status(:unprocessable_content))
  end

  it 'refuses a non-participant with 404 (not 403; anti-enumeration)' do
    other = create(:session)
    join_as(session, role: 'owner') # participant of `session`, not `other`
    post("/api/sessions/#{other.id}/invites", params: { role: 'editor' })
    expect(response).to(have_http_status(:not_found))
  end

  it 'refuses an unauthenticated request with 404' do
    mint
    expect(response).to(have_http_status(:not_found))
  end
end
