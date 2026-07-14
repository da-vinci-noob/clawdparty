# frozen_string_literal: true

require 'rails_helper'

RSpec.describe(FakeClaude::Replay) do
  describe '.call (the W1 replay-end-to-end milestone)' do
    it 'persists durable events, skips ephemeral, and attaches them to a real run' do
      result = described_class.call

      run = AiRun.find(result[:ai_run_id])
      persisted = Event.where(ai_run_id: run.id)
      expect(persisted.count).to(be_positive)
      expect(persisted.pluck(:event_type)).not_to(include('ai_text_delta'))
      expect(run.requested_by).to(be_present)
      expect(run.prompt).to(be_present)
      expect(run.model).to(be_present)
    end

    it 'broadcasts every event to the session (broadcast lives inside Events::Ingest)' do
      allow(SessionChannel).to(receive(:broadcast_to).and_call_original)
      result = described_class.call
      expect(SessionChannel).to(have_received(:broadcast_to).at_least(result[:total]).times)
    end

    it 'moves the run to a terminal status so a fresh replay can start a new run' do
      result = described_class.call
      expect(AiRun.find(result[:ai_run_id]).status).to(eq('completed_clean'))
    end

    it 'two fresh replays do not collide on the unique indexes' do
      first = described_class.call
      second = described_class.call
      expect(second[:ai_run_id]).not_to(eq(first[:ai_run_id]))
      expect(second[:total]).to(eq(first[:total]))
    end

    it 'is idempotent against the same session+run (dedupe on (ai_run_id, seq))' do
      session = create(:session)
      described_class.call(session: session)
      durable_before = Event.count
      # Re-target the same session: its prior run is terminal, a new run is made,
      # but durable rows are not double-counted within a single replay's seqs.
      described_class.call(session: session)
      expect(Event.count).to(be > durable_before) # second run adds its own rows, none duplicated
      # The (ai_run_id, seq) uniqueness binds only RUN-SCOPED rows; session-scoped
      # rows share (null, null) and are correctly distinct under Postgres null semantics.
      run_scoped = Event.where.not(ai_run_id: nil)
      expect(run_scoped.group(:ai_run_id, :seq).count.values.max).to(eq(1))
    end

    it 'asserts CONTRACT_VERSION compatibility from a real consumer' do
      expect(ContractVersion.current).to(include(major: 1))
      expect { described_class.call }.not_to(raise_error)
    end
  end
end
