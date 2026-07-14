# frozen_string_literal: true

require 'rails_helper'

# == Schema Information
#
# Table name: events
# Database name: primary
#
#  id                   :bigint           not null, primary key
#  actor_kind           :enum             not null
#  event_type           :string           not null
#  payload              :jsonb            not null
#  seq                  :bigint
#  created_at           :datetime         not null
#  updated_at           :datetime         not null
#  actor_participant_id :bigint
#  ai_run_id            :bigint
#  session_id           :bigint           not null
#
# Indexes
#
#  index_events_on_actor_participant_id  (actor_participant_id)
#  index_events_on_ai_run_id             (ai_run_id)
#  index_events_on_run_and_seq           (ai_run_id,seq) UNIQUE
#  index_events_on_session_id            (session_id)
#
# Foreign Keys
#
#  fk_rails_...  (actor_participant_id => participants.id)
#  fk_rails_...  (ai_run_id => ai_runs.id)
#  fk_rails_...  (session_id => sessions.id)
#
RSpec.describe(Event) do
  let(:session) { create(:session) }
  let(:ai_run) { create(:ai_run, session: session) }

  describe '(ai_run_id, seq) unique index' do
    it 'rejects a duplicate (ai_run_id, seq) at the DB' do
      create(:event, session: session, ai_run: ai_run, seq: 1)

      expect do
        described_class.create!(session: session, ai_run: ai_run, seq: 1,
                                event_type: 'ai_text', actor_kind: 'claude', payload: {})
      end.to(raise_error(ActiveRecord::RecordNotUnique))
    end

    it 'treats null ai_run_id as distinct, so session-scoped events do not collide' do
      create(:event, :session_scoped, session: session)

      expect { create(:event, :session_scoped, session: session) }.not_to(raise_error)
    end
  end

  describe 'actor check constraint' do
    it 'rejects a user-kind event without a participant id' do
      expect do
        described_class.create!(session: session, ai_run: ai_run, seq: 99,
                                event_type: 'chat_message', actor_kind: 'user',
                                actor_participant_id: nil, payload: {})
      end.to(raise_error(ActiveRecord::StatementInvalid, /events_user_actor_has_participant/))
    end

    it 'rejects a claude-kind event that carries a participant id' do
      participant = create(:participant, session: session)
      expect do
        described_class.create!(session: session, ai_run: ai_run, seq: 98,
                                event_type: 'ai_text', actor_kind: 'claude',
                                actor_participant_id: participant.id, payload: {})
      end.to(raise_error(ActiveRecord::StatementInvalid, /events_user_actor_has_participant/))
    end

    it 'accepts a user-kind event with a participant id' do
      participant = create(:participant, session: session)
      expect do
        described_class.create!(session: session, ai_run: ai_run, seq: 97,
                                event_type: 'chat_message', actor_kind: 'user',
                                actor_participant_id: participant.id, payload: {})
      end.not_to(raise_error)
    end
  end

  describe '#to_envelope' do
    it 'serializes id fields as strings and ts as ISO ms+Z' do
      participant = create(:participant, session: session)
      event = create(:event, session: session, ai_run: ai_run, seq: 5,
                             event_type: 'chat_message', actor_kind: 'user',
                             actor_participant: participant)
      env = event.to_envelope

      expect(env[:session_id]).to(eq(session.id.to_s))
      expect(env[:ai_run_id]).to(eq(ai_run.id.to_s))
      expect(env[:actor]).to(eq({ kind: 'user', id: participant.id.to_s }))
      expect(env[:ts]).to(match(/\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\z/))
    end

    it "serializes a null ai_run_id as null, not the string 'null'" do
      event = create(:event, :session_scoped, session: session)
      expect(event.to_envelope[:ai_run_id]).to(be_nil)
    end
  end

  describe 'taxonomy' do
    it 'freezes exactly 20 type names' do
      expect(described_class::TAXONOMY.size).to(eq(20))
    end
  end
end
