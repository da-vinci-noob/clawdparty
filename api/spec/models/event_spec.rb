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
#  store_seq            :bigint
#  created_at           :datetime         not null
#  updated_at           :datetime         not null
#  actor_participant_id :bigint
#  ai_run_id            :bigint
#  session_id           :bigint           not null
#
# Indexes
#
#  index_events_on_actor_participant_id      (actor_participant_id)
#  index_events_on_ai_run_id                 (ai_run_id)
#  index_events_on_run_and_seq               (ai_run_id,seq) UNIQUE
#  index_events_on_session_id                (session_id)
#  index_events_on_session_id_and_store_seq  (session_id,store_seq)
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

  describe 'actor / participant consistency' do
    it 'is invalid (RecordInvalid, not a DB StatementInvalid) for a user-kind event without a participant' do
      event = described_class.new(session: session, ai_run: ai_run, seq: 99,
                                  event_type: 'chat_message', actor_kind: 'user',
                                  actor_participant_id: nil, payload: {})
      expect(event).not_to(be_valid)
      expect(event.errors[:actor_participant_id]).to(be_present)
      expect { event.save! }.to(raise_error(ActiveRecord::RecordInvalid))
    end

    it 'is invalid for a non-user-kind event that carries a participant id' do
      participant = create(:participant, session: session)
      event = described_class.new(session: session, ai_run: ai_run, seq: 98,
                                  event_type: 'ai_text', actor_kind: 'claude',
                                  actor_participant_id: participant.id, payload: {})
      expect(event).not_to(be_valid)
      expect(event.errors[:actor_participant_id]).to(be_present)
    end

    it 'accepts a user-kind event with a participant id' do
      participant = create(:participant, session: session)
      expect do
        described_class.create!(session: session, ai_run: ai_run, seq: 97,
                                event_type: 'chat_message', actor_kind: 'user',
                                actor_participant_id: participant.id, payload: {})
      end.not_to(raise_error)
    end

    it 'still enforces the rule at the DB when model validation is bypassed (defense in depth)' do
      event = described_class.new(session: session, ai_run: ai_run, seq: 96,
                                  event_type: 'chat_message', actor_kind: 'user',
                                  actor_participant_id: nil, payload: {})
      expect do
        event.save!(validate: false)
      end.to(raise_error(ActiveRecord::StatementInvalid, /events_user_actor_has_participant/))
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

  # A count assertion is not a drift guard: TAXONOMY was missing `user_prompt`
  # (v1.2) and `ai_thinking_delta` (v1.3) while `size == 20` stayed green,
  # because the list and its guard were edited together and neither was compared
  # to the contract. These compare against events.ts itself.
  describe 'taxonomy' do
    it 'matches EVENT_TYPES in packages/contracts/src/events.ts exactly, in order' do
      expect(described_class::TAXONOMY).to(eq(ContractVersion.event_types))
    end

    it 'freezes exactly 30 type names' do
      expect(described_class::TAXONOMY.size).to(eq(30))
    end

    it 'matches EPHEMERAL_EVENT_TYPES in events.ts' do
      expect(described_class::EPHEMERAL_TYPES).to(match_array(ContractVersion.ephemeral_event_types))
    end

    it 'treats every ephemeral type as a member of the taxonomy' do
      expect(described_class::TAXONOMY).to(include(*described_class::EPHEMERAL_TYPES))
    end

    # An ephemeral type absent from EPHEMERAL_TYPES is persisted and handed a
    # durable id, which is the failure mode that makes this worth asserting from
    # the ingest side rather than trusting the constant.
    it 'classifies context_usage as ephemeral' do
      expect(described_class.ephemeral_type?('context_usage')).to(be(true))
    end
  end
end
