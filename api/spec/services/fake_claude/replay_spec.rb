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

    it 'refuses to replay against a contract older than the fixture needs' do
      allow(ContractVersion).to(receive(:current).and_return({ major: 1, minor: 4 }))

      expect { described_class.call }.to(raise_error(described_class::IncompatibleContract))
    end
  end

  # The design record names the Rails replay path as one of four artifacts that
  # MUST pass against sample_run.jsonl. "Passes" has to mean the new types
  # actually flow through ingest — not merely that nothing raised.
  describe 'the v1.5 harness taxonomy' do
    let!(:result) { described_class.call }

    def persisted_types
      Event.where(session_id: result[:session_id]).pluck(:event_type)
    end

    it 'persists every durable harness type' do
      expect(persisted_types).to(include(
                                   'request_header', 'context_compacted', 'tool_refused',
                                   'provider_error', 'recovery_applied', 'user_prompt'
                                 ))
    end

    it 'never persists context_usage — it is ephemeral' do
      expect(persisted_types).not_to(include('context_usage'))
    end

    it 'broadcasts context_usage even though it is not persisted' do
      expect(result[:broadcast]).to(be_positive)
    end

    it 'persists the plugin toggles as session-scoped (null ai_run_id and seq)' do
      toggles = Event.where(session_id: result[:session_id],
                            event_type: %w[plugin_enabled plugin_disabled])

      expect(toggles.count).to(eq(2))
      expect(toggles.pluck(:ai_run_id).uniq).to(eq([nil]))
      expect(toggles.pluck(:seq).uniq).to(eq([nil]))
    end

    it 'attributes harness decisions to the system, not to Claude or a user' do
      system_scoped = Event.where(session_id: result[:session_id],
                                  event_type: %w[request_header context_compacted tool_refused
                                                 provider_error recovery_applied])

      expect(system_scoped.pluck(:actor_kind).uniq).to(eq(['system']))
      expect(system_scoped.pluck(:actor_participant_id).uniq).to(eq([nil]))
    end

    it 'records a credential SOURCE on request_header and never a value' do
      header = Event.find_by(session_id: result[:session_id], event_type: 'request_header')

      expect(header.payload['credential_source']).to(eq('file:~/.claude/.credentials.json'))
      expect(header.payload.to_json).not_to(match(/sk-ant-|access_token|AKIA/))
    end

    it 'keeps recovery_applied uncertainty as an explicit boolean' do
      recovery = Event.find_by(session_id: result[:session_id], event_type: 'recovery_applied')

      # TRUE on purpose. The fixture now captures a real recovery from `request_pending`,
      # which is the load-bearing case (events.md: "never default it to `false` to simplify
      # a display"). Pinning `false` — as this did while the fixture happened to carry it —
      # would pass even if ingest coerced the flag to false, which is the exact bug the
      # assertion exists to catch.
      expect(recovery.payload).to(include('uncertain'))
      expect(recovery.payload['uncertain']).to(be(true))
    end

    it 'rejects no event in the fixture' do
      expect(result[:accepted] + result[:broadcast]).to(eq(result[:total]))
    end
  end
end
