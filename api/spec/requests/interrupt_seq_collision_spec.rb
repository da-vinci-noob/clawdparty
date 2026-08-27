# frozen_string_literal: true

require 'rails_helper'

# The last place Rails allocated a seq out of the harness's space, found while auditing the
# remaining copies of `(run.events.maximum(:seq) || 0) + 1` after an earlier fix covered two of five.
#
# `RunsController#reconcile_interrupted` runs when the harness answers UnknownRun — it restarted, so
# it has no such ACTIVE run, while Rails still shows one. Its comment claimed "Rails owns the next
# seq since the harness is no longer emitting for this run", which is the same assumption that made
# `HealthcheckJob` destroy `recovery_applied`, and it is false for the same reason: a restarted
# harness runs BOOT RECOVERY over that very run and emits `recovery_applied` from its own store.
#
# The window is narrow and real. Recovery completes before the server serves, so the harness answers
# UnknownRun only afterwards — but shipping is asynchronous and retried, so the POST can still be in
# flight (or backing off, if Rails was briefly down) when the interrupt arrives. Rails then takes the
# seq recovery already used, the insert loses to `UNIQUE (ai_run_id, seq)`, and `Events::Ingest`
# reports `skipped` — indistinguishable from a retry.
#
# Unlike the `changeset_*` sites, this one is genuinely reachable: the run is ACTIVE, so the harness
# still holds a non-terminal position marker. Where the run is terminal the harness can never
# allocate again, because the terminal entry and the terminal marker are ONE `store.commit`.
RSpec.describe('an interrupt reconciled by Rails does not consume the harness\'s seq') do
  let(:session) { create(:session) }
  let(:run) { create(:ai_run, session: session, status: 'running') }

  def project(upto)
    (1..upto).each do |seq|
      create(:event, session: session, ai_run: run, seq: seq, store_seq: seq, event_type: 'ai_text')
    end
  end

  def interrupt!
    participant = session.participants.first || create(:participant, session: session, role: 'owner')
    controller = RunsController.new
    controller.send(:reconcile_interrupted, run, participant)
  end

  it 'leaves the harness free to ingest its own next seq afterwards' do
    project(17)
    interrupt!

    result = Events::Ingest.call(
      session_id: session.id, ai_run_id: run.id, seq: 18, store_seq: 18,
      type: 'recovery_applied', actor: { kind: 'system' },
      payload: { run_id: run.id.to_s, from_phase: 'tools', action: 'abandoned', uncertain: false }
    )

    expect(result).to(be_accepted)
    expect(Event.where(ai_run: run, event_type: 'recovery_applied')).to(exist)
  end

  it 'claims no position in the record for an event the record never held' do
    project(17)

    interrupt!

    interrupted = Event.where(ai_run: run, event_type: 'run_interrupted').sole
    expect(interrupted.seq).to(be_nil)
    expect(interrupted.store_seq).to(be_nil)
  end

  it 'still finalizes the run, which is the whole point of reconciling' do
    project(17)

    interrupt!

    # Not a specific terminal status — `Runs::Finalize` lands an interrupted run with no diff on
    # `completed_clean`, and pinning the label would break the next time that mapping is refined.
    # What the caller needs is that the run is no longer ACTIVE, so the session unblocks.
    expect(run.reload).not_to(be_active)
  end
end
