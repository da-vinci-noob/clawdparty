# frozen_string_literal: true

require 'rails_helper'

RSpec.describe(Events::Ingest) do
  let(:session) { create(:session) }
  let(:ai_run) { create(:ai_run, session: session) }

  def durable_attrs(seq:, type: 'ai_text')
    { 'session_id' => session.id, 'ai_run_id' => ai_run.id, 'seq' => seq,
      'type' => type, 'actor' => { 'kind' => 'claude' }, 'payload' => {} }
  end

  describe 'persistence + dedupe' do
    it 'persists a durable event once' do
      expect { described_class.call(durable_attrs(seq: 1)) }.to(change(Event, :count).by(1))
    end

    it 'silently skips a duplicate (ai_run_id, seq) without raising' do
      described_class.call(durable_attrs(seq: 1))

      result = nil
      expect { result = described_class.call(durable_attrs(seq: 1)) }.not_to(change(Event, :count))
      expect(result).to(be_skipped)
    end

    it 'does not persist ephemeral events' do
      attrs = { 'session_id' => session.id, 'ai_run_id' => ai_run.id, 'seq' => nil,
                'type' => 'ai_text_delta', 'actor' => { 'kind' => 'claude' }, 'payload' => {} }
      expect { described_class.call(attrs) }.not_to(change(Event, :count))
    end

    it 'treats ai_thinking_delta as ephemeral (broadcast, not persisted)' do
      attrs = { 'session_id' => session.id, 'ai_run_id' => ai_run.id, 'seq' => nil,
                'type' => 'ai_thinking_delta', 'actor' => { 'kind' => 'claude' },
                'payload' => { 'block' => 'm:0', 'text' => 'hmm' } }
      result = nil
      expect { result = described_class.call(attrs) }.not_to(change(Event, :count))
      expect(result).to(be_broadcast)
    end
  end

  describe 'broadcast (inside the service)' do
    it 'broadcasts a durable event to the session channel' do
      expect do
        described_class.call(durable_attrs(seq: 1))
      end.to(have_broadcasted_to(session).from_channel(SessionChannel))
    end

    it 'broadcasts an ephemeral event with null id AND null seq' do
      attrs = { 'session_id' => session.id, 'ai_run_id' => ai_run.id, 'seq' => nil,
                'type' => 'ai_text_delta', 'actor' => { 'kind' => 'claude' }, 'payload' => {} }
      expect do
        described_class.call(attrs)
      end.to(
        have_broadcasted_to(session).from_channel(SessionChannel).with do |data|
          expect(data[:id]).to(be_nil)
          expect(data[:seq]).to(be_nil)
        end
      )
    end
  end

  describe 'user_prompt (run-scoped durable; v1.2)' do
    let(:requester) { create(:participant, session: session, role: 'owner') }

    def prompt_attrs(seq:, text: 'build it', participant: nil)
      { 'session_id' => session.id, 'ai_run_id' => ai_run.id, 'seq' => seq, 'type' => 'user_prompt',
        'actor' => { 'kind' => 'user', 'id' => (participant || requester).id },
        'payload' => { 'text' => text } }
    end

    it 'persists a user_prompt verbatim as a durable run-scoped event' do
      result = described_class.call(prompt_attrs(seq: 1, participant: requester))

      expect(result).to(be_accepted)
      event = result.event
      expect(event.event_type).to(eq('user_prompt'))
      expect(event.ai_run_id).to(eq(ai_run.id))
      expect(event.seq).to(eq(1))
      expect(event.actor_kind).to(eq('user'))
      expect(event.actor_participant_id).to(eq(requester.id))
      expect(event.payload).to(eq({ 'text' => 'build it' }))
    end

    it 'broadcasts the user_prompt to the session channel' do
      expect do
        described_class.call(prompt_attrs(seq: 1))
      end.to(have_broadcasted_to(session).from_channel(SessionChannel))
    end

    it 'dedupes a repeated (ai_run_id, seq)' do
      described_class.call(prompt_attrs(seq: 1))
      result = nil
      expect { result = described_class.call(prompt_attrs(seq: 1)) }.not_to(change(Event, :count))
      expect(result).to(be_skipped)
    end

    it 'does not transition the run state (it is not a lifecycle event)' do
      ai_run.update!(status: 'running')
      expect do
        described_class.call(prompt_attrs(seq: 5))
      end.not_to(change { ai_run.reload.status })
    end
  end

  describe 'a user actor missing its participant id (malformed envelope)' do
    # Repro: a chat_message whose actor is { kind: "user" } with NO id. The
    # "user actor MUST carry a participant" rule lived only in the DB check
    # constraint, so this hit Postgres as an uncatchable StatementInvalid (500)
    # and dropped the event. Ingest must reject it cleanly instead.
    def bad_user_attrs
      { 'session_id' => session.id, 'type' => 'chat_message',
        'actor' => { 'kind' => 'user' }, 'payload' => {} }
    end

    it 'is rejected without raising, and persists nothing' do
      result = nil
      expect { result = described_class.call(bad_user_attrs) }.not_to(raise_error)
      expect(result).to(be_rejected)
      expect(Event.count).to(eq(0))
    end

    it 'does not broadcast a rejected event' do
      expect { described_class.call(bad_user_attrs) }.not_to(
        have_broadcasted_to(session).from_channel(SessionChannel)
      )
    end
  end
end
