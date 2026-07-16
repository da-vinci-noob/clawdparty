# frozen_string_literal: true

require 'rails_helper'

RSpec.describe('Session invites API') do
  let(:session) { create(:session) }

  describe 'POST /api/sessions/:id/invites (mint invite)' do
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
      invite = Invite.find_by(token_digest: Invite.digest_for(body['token']))
      expect(invite.role).to(eq('reviewer'))
      # The response carries the invite id so the UI can revoke a just-minted link.
      expect(body['id']).to(eq(invite.id.to_s))
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

  describe 'GET /api/sessions/:id/invites (list invites)' do
    it 'lets an owner list invites with derived status and no token material' do
      join_as(session, role: 'owner')
      active = create(:invite, session: session, role: 'editor')
      revoked = create(:invite, :revoked, session: session, role: 'reviewer')
      expired = create(:invite, :expired, session: session, role: 'viewer')

      get("/api/sessions/#{session.id}/invites")
      expect(response).to(have_http_status(:ok))

      by_id = response.parsed_body.index_by { |i| i['id'] }
      expect(by_id[active.id.to_s]).to(include('role' => 'editor', 'status' => 'active'))
      expect(by_id[revoked.id.to_s]['status']).to(eq('revoked'))
      expect(by_id[expired.id.to_s]['status']).to(eq('expired'))
      # The count of tokens is the list length; each item exposes metadata + status only.
      expect(response.parsed_body.size).to(be >= 3)
      expect(by_id[active.id.to_s].keys).to(match_array(%w[id role created_at expires_at status]))
    end

    %w[editor reviewer viewer].each do |role|
      it "denies a #{role} the list with 403 (owner-only)" do
        join_as(session, role: role)
        get("/api/sessions/#{session.id}/invites")
        expect(response).to(have_http_status(:forbidden))
      end
    end

    it 'refuses a non-participant with 404 (anti-enumeration)' do
      other = create(:session)
      join_as(session, role: 'owner')
      get("/api/sessions/#{other.id}/invites")
      expect(response).to(have_http_status(:not_found))
    end

    it 'refuses an unauthenticated request with 404' do
      get("/api/sessions/#{session.id}/invites")
      expect(response).to(have_http_status(:not_found))
    end
  end

  describe 'DELETE /api/sessions/:id/invites/:id (revoke invite)' do
    it 'lets an owner revoke an invite (204) so its token can no longer join' do
      join_as(session, role: 'owner')
      invite, raw = Invite.generate!(session: session, role: 'editor')

      delete("/api/sessions/#{session.id}/invites/#{invite.id}")
      expect(response).to(have_http_status(:no_content))
      expect(response.body).to(be_blank)
      expect(invite.reload.revoked?).to(be(true))

      expect { post('/api/participants', params: { token: raw, name: 'Late' }) }
        .not_to(change(Participant, :count))
      expect(response).to(have_http_status(:not_found))
    end

    it 'is idempotent (revoking an already-revoked invite is 204)' do
      join_as(session, role: 'owner')
      invite = create(:invite, :revoked, session: session)
      delete("/api/sessions/#{session.id}/invites/#{invite.id}")
      expect(response).to(have_http_status(:no_content))
      expect(invite.reload.revoked?).to(be(true))
    end

    %w[editor reviewer viewer].each do |role|
      it "denies a #{role} revoke with 403 and leaves the invite intact" do
        join_as(session, role: role)
        invite = create(:invite, session: session)
        delete("/api/sessions/#{session.id}/invites/#{invite.id}")
        expect(response).to(have_http_status(:forbidden))
        expect(invite.reload.revoked?).to(be(false))
      end
    end

    it 'treats an invite id from another session as not found (404)' do
      other = create(:session)
      other_invite = create(:invite, session: other)
      join_as(session, role: 'owner')
      delete("/api/sessions/#{session.id}/invites/#{other_invite.id}")
      expect(response).to(have_http_status(:not_found))
      expect(other_invite.reload.revoked?).to(be(false))
    end

    it 'does not evict already-joined participants when their invite is revoked' do
      join_as(session, role: 'owner')
      invite = create(:invite, session: session, role: 'editor')
      existing = create(:participant, session: session, role: 'editor')

      expect { delete("/api/sessions/#{session.id}/invites/#{invite.id}") }
        .not_to(change(Participant, :count))
      expect(response).to(have_http_status(:no_content))
      expect(existing.reload.role).to(eq('editor'))
    end
  end
end
