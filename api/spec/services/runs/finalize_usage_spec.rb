# frozen_string_literal: true

require 'rails_helper'

# `ai_runs.usage` and `ai_runs.total_cost_usd` existed and were NEVER written — nil on every
# run, for every provider. The terminal event carries the figures (`run_finished.usage`), the
# columns are there to hold them, and nothing connected the two, so any server-side reading of
# what a run cost had nothing to read. The web context bar reads the EVENT, which is why the
# gap stayed invisible.
#
# `nil` is load-bearing on both columns and must stay reachable: it means "the provider reported
# nothing", which is a different statement from `0`. Zero says the turn was free, and no request
# that was actually made is free.
RSpec.describe(Runs::Finalize) do
  let(:session) { create(:session, mode: 'chat') }
  let(:run) { create(:ai_run, session: session, status: 'running') }
  let(:usage) do
    {
      'input_tokens' => 685,
      'output_tokens' => 13,
      'cache_read_input_tokens' => 20,
      'cache_creation_input_tokens' => 5
    }
  end

  def ingest(type, payload, seq: 9)
    Events::Ingest.call(
      'session_id' => session.id,
      'ai_run_id' => run.id,
      'seq' => seq,
      'type' => type,
      'actor' => { 'kind' => 'system' },
      'ts' => Time.current.iso8601(3),
      'payload' => payload
    )
  end

  describe 'run_finished' do
    it 'records the usage the provider reported' do
      ingest('run_finished', { 'usage' => usage, 'stop_reason' => 'end_turn' })

      expect(run.reload.usage).to(eq(usage))
    end

    it 'records a cost the harness computed' do
      ingest('run_finished', { 'usage' => usage, 'total_cost_usd' => '0.004212' })

      expect(run.reload.total_cost_usd).to(eq(BigDecimal('0.004212')))
    end

    it 'leaves cost NIL when the harness reported none' do
      # Unknown, not free. Storing 0 would make every Bedrock run look free in any later
      # report, which is a false statement rather than a missing one.
      ingest('run_finished', { 'usage' => usage })

      expect(run.reload.total_cost_usd).to(be_nil)
    end

    it 'leaves usage NIL when the provider reported none' do
      # Same rule as the harness ledger: no report means no row, never zeros.
      ingest('run_finished', { 'stop_reason' => 'end_turn' })

      expect(run.reload.usage).to(be_nil)
    end

    it 'still applies the status transition' do
      ingest('run_finished', { 'usage' => usage })

      expect(run.reload.status).to(eq('completed_clean'))
    end
  end

  describe 'run_failed' do
    it 'records the usage a failed run consumed' do
      # A run that failed on turn 3 still spent turns 1 and 2. Discarding that hides real cost.
      ingest('run_failed', { 'usage' => usage, 'stop_reason' => 'api_error' })

      expect(run.reload.usage).to(eq(usage))
      expect(run.reload.status).to(eq('failed'))
    end
  end

  describe 'run_interrupted' do
    it 'records usage when the payload carries it' do
      ingest('run_interrupted', { 'usage' => usage })
      expect(run.reload.usage).to(eq(usage))
    end

    it 'does not fail when the payload is empty, which is its contract shape' do
      # RunInterruptedPayload is `Record<string, never>` — an empty object by contract.
      expect { ingest('run_interrupted', {}) }.not_to(raise_error)
      expect(run.reload.usage).to(be_nil)
    end
  end

  describe 'events that carry no usage' do
    it 'does not touch the columns on run_started' do
      run.update!(usage: usage, total_cost_usd: BigDecimal('1.5'))
      ingest('run_started', { 'model' => 'm', 'cwd' => '/r' }, seq: 1)

      # A later lifecycle event must not erase what an earlier one recorded.
      expect(run.reload.usage).to(eq(usage))
      expect(run.reload.total_cost_usd).to(eq(BigDecimal('1.5')))
    end
  end
end
