# frozen_string_literal: true

require 'rails_helper'

# PARTICIPANT re-auth, which is a different subject from provider credentials.
#
# `connection_spec.rb` and `join_spec.rb` cover ESTABLISHING the `clawd_uid` cookie. What was
# untested is what happens to an identity that was already established and then stops working:
#
#   * the cookie goes missing or unparseable MID-SESSION — a reconnect must REFUSE, never silently
#     downgrade someone to a role they do not have;
#   * an invite is REVOKED while its holder is connected.
#
# The second one turned out not to work the way it was expected to, and the finding is recorded in the
# examples below rather than smoothed over: revocation governs the LINK, not the PERSON.
RSpec.describe('Participant re-auth') do
  let(:session) { create(:session) }

  # Measured, because the obvious call does nothing: `cookies.delete(name)` in a request spec leaves
  # the integration session still sending the cookie (verified — the next request still returned
  # 200). Assigning an empty value is what actually unauthenticates, and it is also the truer
  # simulation: a browser with a cleared cookie sends no usable value rather than un-sending it.
  def lose_identity!
    cookies[ApplicationController::COOKIE_NAME] = ''
  end

  describe 'a cookie that stops working mid-session' do
    it 'refuses the REST request rather than serving it with no role' do
      join_as(session, role: 'editor')
      get("/api/sessions/#{session.id}")
      expect(response).to(have_http_status(:ok))

      # The cookie is gone — a browser cleared it, or it expired.
      lose_identity!
      get("/api/sessions/#{session.id}")

      # 404, not 200-with-no-role and not 401: an unauthenticated caller must not learn whether the
      # session exists (anti-enumeration), and must certainly not be served its contents.
      expect(response).to(have_http_status(:not_found))
    end

    it 'refuses a FORGED cookie the same way' do
      join_as(session, role: 'owner')
      cookies[ApplicationController::COOKIE_NAME] = '999999'

      get("/api/sessions/#{session.id}")

      # Unsigned, so it does not verify. Reading it as a user id would let anyone become anyone.
      expect(response).to(have_http_status(:not_found))
    end

    it 'does not silently DOWNGRADE a participant to a lesser role' do
      join_as(session, role: 'owner')
      lose_identity!

      # An owner-only action. Refused as unknown rather than as forbidden — a 403 would confirm the
      # session exists, and a silent downgrade to "viewer" would be the worst of the three.
      post("/api/sessions/#{session.id}/archive")

      expect(response).to(have_http_status(:not_found))
      expect(session.reload.status).to(eq('active'))
    end

    it 'works again immediately once the identity is re-established' do
      join_as(session, role: 'editor')
      lose_identity!
      get("/api/sessions/#{session.id}")
      expect(response).to(have_http_status(:not_found))

      # RE-JOINING, which is what a browser actually does after a cleared cookie — and the only
      # route back in, since `cookies.signed` is not writable from a request spec's jar. The
      # recovery has to go through the real flow, which is the better test regardless.
      join_as(session, role: 'editor', name: 'Tester Again')
      get("/api/sessions/#{session.id}")

      expect(response).to(have_http_status(:ok))
    end
  end

  describe 'an invite revoked while its holder is connected' do
    # FINDING: revocation governs the LINK, not the PERSON. There is no eject action —
    # `participants` is create-only — so a revoked invite stops FUTURE joins and leaves existing
    # participants exactly as they were.
    #
    # That is defensible and probably right: revoking a link you posted in a channel should not
    # kick out the colleague who joined with it legitimately. But it means the original expectation
    # ("revocation should end the stream") is NOT what happens, and the gap it exposes is a
    # different one — an owner who invited the wrong person has no way to remove them, only to
    # archive the whole session. Recorded as follow-up work rather than silently implemented, because
    # "remove a participant" is a product decision with its own consequences (their events stay in
    # the feed; their approvals stay approved).
    def invite_and_token(role: 'editor')
      Invite.generate!(session: session, role: role)
    end

    def join_with(token)
      post('/api/participants', params: { token: token, name: 'Joiner' })
    end

    it 'stops a NEW join with the revoked token' do
      invite, raw = invite_and_token
      invite.update!(revoked_at: Time.current)

      join_with(raw)

      # 404 rather than 403, and indistinguishable from an unknown or expired token — a revoked
      # link must not confirm that it was ever real.
      expect(response).to(have_http_status(:not_found))
    end

    it 'leaves an existing participant able to use the session' do
      invite, raw = invite_and_token
      join_with(raw)
      expect(response).to(have_http_status(:created))

      invite.update!(revoked_at: Time.current)
      get("/api/sessions/#{session.id}")

      # The documented behaviour, asserted so a later change to it is deliberate: the participant
      # row is the grant once someone has joined, and it is untouched by revoking the link.
      expect(response).to(have_http_status(:ok))
    end

    it 'keeps their participant row and role' do
      invite, raw = invite_and_token
      join_with(raw)
      invite.update!(revoked_at: Time.current)

      expect(session.participants.order(:id).last.role).to(eq('editor'))
    end

    it 'is now removable by an owner' do
      # This was asserted as an ABSENCE before removal existed, and it FAILED the moment removal
      # shipped — which is exactly what an absence assertion is for. Kept, inverted, so the route's
      # existence is now the pinned fact.
      expect(Rails.application.routes.routes.map { |r| [r.verb, r.path.spec.to_s] })
        .to(include(['DELETE', '/api/sessions/:session_id/participants/:id(.:format)']))
    end

    it 'still leaves REVOCATION distinct from removal' do
      invite, raw = invite_and_token
      join_with(raw)
      invite.update!(revoked_at: Time.current)

      # Revoking the link does not remove anyone; removal is a separate, deliberate act. Conflating
      # them would eject the colleague who used the link legitimately.
      expect(session.participants.count).to(be >= 1)
    end
  end

  describe 'archive is the lever that DOES exist' do
    it 'stops new runs for everyone, including existing participants' do
      join_as(session, role: 'owner')
      post("/api/sessions/#{session.id}/archive")

      expect(session.reload.status).to(eq('archived'))
      # The only session-wide revocation the product has today. It closes the room rather than
      # removing one person from it — a different action from what revocation was assumed to be.
      expect do
        Runs::Start.call(session: session.reload, requested_by: session.participants.first,
                         prompt: 'go', model: 'm')
      end
        .to(raise_error(Runs::Start::SessionArchived))
    end
  end
end
