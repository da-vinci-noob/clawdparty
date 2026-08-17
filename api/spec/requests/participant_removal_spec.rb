# frozen_string_literal: true

require 'rails_helper'

# An owner revokes someone's access.
#
# Found earlier: revoking an INVITE stops future joins and leaves existing participants untouched
# (correctly — revoking a link you posted should not eject the colleague who used it legitimately),
# so an owner who admitted the wrong person had one lever and it closed the whole room.
#
# The decision that shaped this is what removal MEANS for the record: it revokes FUTURE access and
# does not rewrite the past. The event stream is append-only, so their messages stay in the feed,
# still attributed, and their approvals stay approved. A removal that erased their contributions
# would leave a record claiming a changeset was approved by nobody.
RSpec.describe('Participant removal') do
  let(:session) { create(:session) }

  # A second participant to remove — `join_as` makes the CALLER, so the target is created directly.
  def other_participant(role: 'editor', name: 'Priya')
    Participant.create!(session: session, user: User.create!(name: name), role: role)
  end

  describe 'an owner removing someone' do
    it 'revokes their participantship without deleting the row' do
      target = other_participant
      join_as(session, role: 'owner')

      expect do
        delete("/api/sessions/#{session.id}/participants/#{target.id}")
      end.to(change { session.participants.active.count }.by(-1))

      expect(response).to(have_http_status(:ok))
      expect(response.parsed_body).to(include('removed' => true))
      # The ROW survives, because it is the referent for their history — `events.actor_participant_id`
      # has a foreign key and a hard delete is refused by the database.
      expect(target.reload.removed_at).to(be_present)
      expect(session.participants.count).to(eq(2))
    end

    it 'is a 404 the second time, not a second event' do
      target = other_participant
      join_as(session, role: 'owner')
      delete("/api/sessions/#{session.id}/participants/#{target.id}")

      expect do
        delete("/api/sessions/#{session.id}/participants/#{target.id}")
      end.not_to(change(Event, :count))
      expect(response).to(have_http_status(:not_found))
    end

    it 'announces it, attributed to the owner who did it' do
      target = other_participant
      owner = join_as(session, role: 'owner')

      expect do
        delete("/api/sessions/#{session.id}/participants/#{target.id}")
      end.to(change { session.events.where(event_type: 'participant_removed').count }.by(1))

      event = session.events.where(event_type: 'participant_removed').last
      # The room learns of it the same way it learns everything else — and by whom.
      expect(event.actor_participant_id).to(eq(owner.id))
      expect(event.payload).to(include('participant_id' => target.id.to_s, 'name' => 'Priya'))
    end

    it 'carries the NAME, because the row is gone by the time anyone renders it' do
      target = other_participant(name: 'Removed Person')
      join_as(session, role: 'owner')

      delete("/api/sessions/#{session.id}/participants/#{target.id}")

      # Resolving a deleted participant id would render "#12" or nothing at all.
      expect(session.events.where(event_type: 'participant_removed').last.payload['name'])
        .to(eq('Removed Person'))
    end
  end

  describe 'what removal does NOT do' do
    it 'leaves their chat messages in the feed, still attributed' do
      target = other_participant
      Events::Append.call(
        session: session,
        event: { type: 'chat_message', actor: { kind: 'user', id: target.id },
                 payload: { body: 'something they said' } }
      )
      join_as(session, role: 'owner')

      delete("/api/sessions/#{session.id}/participants/#{target.id}")

      said = session.events.where(event_type: 'chat_message').last
      # Append-only. Erasing this would rewrite the room's history to hide that a conversation
      # happened — a bigger lie than leaving it.
      expect(said).to(be_present)
      expect(said.actor_participant_id).to(eq(target.id))
    end

    it 'leaves a changeset they approved still approved' do
      target = other_participant(role: 'reviewer')
      run = create(:ai_run, session: session, status: 'approved', reviewed_by: target)
      join_as(session, role: 'owner')

      delete("/api/sessions/#{session.id}/participants/#{target.id}")

      # `reviewed_by` would dangle if the row were hard-deleted without thought — and a run reporting
      # no reviewer would claim work was approved by nobody. Asserted so the FK behaviour is a pinned
      # fact rather than an assumption.
      expect(run.reload.status).to(eq('approved'))
    end
  end

  describe 'who may do it' do
    %w[editor reviewer viewer].each do |role|
      it "refuses a #{role} with 403, removing nothing" do
        target = other_participant
        join_as(session, role: role)

        expect do
          delete("/api/sessions/#{session.id}/participants/#{target.id}")
        end.not_to(change { session.participants.active.count })

        expect(response).to(have_http_status(:forbidden))
      end
    end

    it 'refuses an unauthenticated request with 404 (anti-enumeration)' do
      target = other_participant

      delete("/api/sessions/#{session.id}/participants/#{target.id}")

      expect(response).to(have_http_status(:not_found))
    end

    it 'refuses a participant of ANOTHER session with 404' do
      target = other_participant
      join_as(create(:session), role: 'owner')

      delete("/api/sessions/#{session.id}/participants/#{target.id}")

      expect(response).to(have_http_status(:not_found))
    end
  end

  describe 'what cannot be removed' do
    it 'refuses to remove the HOST' do
      owner = join_as(session, role: 'owner')
      session.update!(host_id: owner.user_id)

      delete("/api/sessions/#{session.id}/participants/#{owner.id}")

      # `sessions.host_id` would dangle, and "the owner removed themselves" leaves a room nobody can
      # administer. Archive is the lever for closing a session.
      expect(response).to(have_http_status(:unprocessable_content))
      expect(response.parsed_body['errors'].first['message']).to(match(/archive/i))
      expect(session.participants.exists?(owner.id)).to(be(true))
    end

    it '404s on a participant id that is not in this session' do
      join_as(session, role: 'owner')
      stranger = Participant.create!(session: create(:session), user: User.create!(name: 'Elsewhere'),
                                     role: 'editor')

      delete("/api/sessions/#{session.id}/participants/#{stranger.id}")

      expect(response).to(have_http_status(:not_found))
      expect(stranger.reload).to(be_present)
    end

    it 'appends no event when the removal was refused' do
      owner = join_as(session, role: 'owner')
      session.update!(host_id: owner.user_id)

      expect do
        delete("/api/sessions/#{session.id}/participants/#{owner.id}")
      end.not_to(change(Event, :count))
      # The record and its announcement must not disagree.
    end
  end

  describe 'access afterwards' do
    it 'stops the removed participant reaching the session' do
      # The removed person's own cookie is what matters, so THEY are the caller here and the owner is
      # created directly.
      target = join_as(session, role: 'editor')
      owner = Participant.create!(session: session, user: User.create!(name: 'Owner'), role: 'owner')
      session.update!(host_id: owner.user_id)

      get("/api/sessions/#{session.id}")
      expect(response).to(have_http_status(:ok))

      target.update!(removed_at: Time.current)

      # The cookie still verifies — it is PARTICIPANTSHIP that is gone, which is the property both the
      # REST check and the cable subscription ask about via `participants.active`.
      get("/api/sessions/#{session.id}")
      expect(response).to(have_http_status(:not_found))
    end
  end
end
