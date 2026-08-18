# frozen_string_literal: true

require 'rails_helper'

# Rails and the harness both allocate `seq` for the SAME run, from different places, and the
# idempotency mechanism then silently discards the harness's event as a duplicate.
#
# Found by running scenario S3 against the live stack. A real run was SIGKILLed mid-tool; on
# restart the harness recovered it correctly (`from_phase: request_pending, action: abandoned,
# uncertain: true` — logged, honest) and shipped `recovery_applied`. It is in neither the store nor
# Postgres. The store's last emitted seq for that run was 17, so the harness allocated 18; Rails'
# staleness sweep had already appended `run_failed` at seq 18, taken from
# `(run.events.maximum(:seq) || 0) + 1`. The insert hit `UNIQUE (ai_run_id, seq)` and
# `Events::Ingest` treats that as a retry — silently skipped, never raised.
#
# The collision is structural, not incidental: Rails computes its next seq from the PROJECTION,
# which is by definition behind the record, so the value it picks is always one the harness may
# still use. And it only fires on the crash/orphan paths — `HealthcheckJob` and `Harness::Reconcile`
# are the only Rails code that appends run-scoped events — which is exactly when the harness is
# concurrently recovering. So the one event that explains why a run restarted is the one event this
# loses, in the only scenario it exists to document.
RSpec.describe('a Rails-appended run event does not consume the harness\'s seq') do
  let(:session) { create(:session) }

  def stale_run
    create(:ai_run, session: session, status: 'running').tap do |run|
      run.update_column(:last_heartbeat_at, 20.seconds.ago) # rubocop:disable Rails/SkipsModelValidations
    end
  end

  # The record's own events, as the harness projected them before the crash.
  def project(run, upto)
    (1..upto).map do |seq|
      create(:event, session: session, ai_run: run, seq: seq, store_seq: seq, event_type: 'ai_text')
    end
  end

  it 'leaves the harness free to ingest its next seq after the sweep has run' do
    run = stale_run
    project(run, 17)
    Harness::HealthcheckJob.perform_now

    result = Events::Ingest.call(
      session_id: session.id, ai_run_id: run.id, seq: 18, store_seq: 18,
      type: 'recovery_applied', actor: { kind: 'system' },
      payload: { run_id: run.id.to_s, from_phase: 'request_pending',
                 action: 'abandoned', uncertain: true }
    )

    # Skipped means the projection has a row at (run, 18) that is NOT this event, and the caller
    # was told nothing — the harness's transport treats a skip as delivered.
    expect(result).to(be_accepted)
    expect(Event.where(ai_run: run, event_type: 'recovery_applied')).to(exist)
  end

  it 'does not claim a position in the record for an event the record never held' do
    run = stale_run
    project(run, 17)

    Harness::HealthcheckJob.perform_now

    failed = Event.where(ai_run: run, event_type: 'run_failed').sole
    # `seq` and `store_seq` are both properties of the RECORD. Rails appended this itself, so it
    # holds neither — the same reasoning that scopes a projection reset to `store_seq NOT NULL`.
    expect(failed.store_seq).to(be_nil)
    expect(failed.seq).to(be_nil)
  end
end
