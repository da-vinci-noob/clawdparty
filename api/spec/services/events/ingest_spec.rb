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
end
