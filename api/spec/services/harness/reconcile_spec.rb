# frozen_string_literal: true

require 'rails_helper'

# Rails and the harness agree on which runs are active, and the harness wins.
#
# The direction of the win is the whole point. Rails holds a projection; the harness
# holds the record. Every case below is written so that reversing the winner would fail
# it, because "reconcile" is the kind of word that reads fine while doing the opposite.
RSpec.describe(Harness::Reconcile) do
  let(:session) { create(:session) }

  def client_reporting(runs, status: 200)
    instance_double(Harness::Client, list_runs: Harness::Client::Result.new(status: status, body: { 'runs' => runs }))
  end

  def entry(run, store_seq: 12)
    { 'run_id' => run.id.to_s, 'session_id' => run.session_id.to_s, 'lane' => 'main', 'store_seq' => store_seq }
  end

  describe 'Rails thinks active, the harness says idle' do
    it 'fails a running run the harness no longer holds' do
      run = create(:ai_run, session: session, status: 'running')

      result = described_class.call(client: client_reporting([]))

      expect(run.reload.status).to(eq('failed'))
      expect(result.failed).to(eq([run.id]))
    end

    it 'fails a queued run the harness never picked up' do
      run = create(:ai_run, session: session, status: 'queued')

      described_class.call(client: client_reporting([]))

      expect(run.reload.status).to(eq('failed'))
    end

    it 'appends a run_failed event naming the harness as the cause' do
      run = create(:ai_run, session: session, status: 'running')

      described_class.call(client: client_reporting([]))

      event = Event.where(ai_run_id: run.id, event_type: 'run_failed').last
      expect(event).to(be_present)
      expect(event.payload['stop_reason']).to(eq('harness_lost_run'))
    end

    it 'leaves awaiting_review alone — the harness finished that run and dropped it' do
      run = create(:ai_run, session: session, status: 'awaiting_review')

      result = described_class.call(client: client_reporting([]))

      # The discriminating case: awaiting_review is in ACTIVE_STATUSES, so a naive
      # "fail everything active the harness does not report" would destroy a diff
      # waiting on a human.
      expect(run.reload.status).to(eq('awaiting_review'))
      expect(result.failed).to(be_empty)
    end

    it 'leaves a run the harness DOES report untouched' do
      run = create(:ai_run, session: session, status: 'running')

      described_class.call(client: client_reporting([entry(run)]))

      expect(run.reload.status).to(eq('running'))
    end
  end

  describe 'the harness says active, Rails thinks otherwise' do
    it 'restores a run Rails had failed' do
      run = create(:ai_run, session: session, status: 'failed')

      result = described_class.call(client: client_reporting([entry(run)]))

      expect(run.reload.status).to(eq('running'))
      expect(result.restored).to(eq([run.id]))
    end

    it 'restores a run Rails had concluded clean' do
      run = create(:ai_run, session: session, status: 'completed_clean')

      described_class.call(client: client_reporting([entry(run)]))

      expect(run.reload.status).to(eq('running'))
    end

    it 'stamps a heartbeat on restore so the sweeper does not immediately re-fail it' do
      run = create(:ai_run, session: session, status: 'failed', last_heartbeat_at: 1.hour.ago)

      described_class.call(client: client_reporting([entry(run)]))

      # Restoring to `running` without refreshing liveness would hand the run straight
      # to HealthcheckJob's 15s staleness sweep — reconciled and re-failed in one tick.
      expect(run.reload.last_heartbeat_at).to(be > 1.minute.ago)
    end

    %w[approved rejected].each do |decided|
      it "reports #{decided} as an unresolved conflict rather than resurrecting it" do
        run = create(:ai_run, session: session, status: decided)

        result = described_class.call(client: client_reporting([entry(run)]))

        # Both of these already acted on the worktree — committed or reverted. Calling
        # the run `running` again would describe work on a tree that no longer exists,
        # so the conflict is surfaced instead of papered over.
        expect(run.reload.status).to(eq(decided))
        expect(result.conflicts).to(eq([run.id]))
        expect(result.restored).to(be_empty)
      end
    end
  end

  describe 'settling losers before restoring winners' do
    it 'frees the one-active-run slot so both sides of a swap reconcile' do
      lost = create(:ai_run, session: session, status: 'running')
      held = create(:ai_run, session: session, status: 'failed')

      result = described_class.call(client: client_reporting([entry(held)]))

      # index_ai_runs_one_active_per_session permits ONE active run per session, so
      # restoring `held` before failing `lost` raises RecordNotUnique. The ordering is
      # load-bearing, not cosmetic.
      expect(lost.reload.status).to(eq('failed'))
      expect(held.reload.status).to(eq('running'))
      expect(result.failed).to(eq([lost.id]))
      expect(result.restored).to(eq([held.id]))
    end
  end

  describe 'an unreachable harness reconciles nothing' do
    it 'does not fail live runs when the call raises' do
      run = create(:ai_run, session: session, status: 'running')
      client = instance_double(Harness::Client)
      allow(client).to(receive(:list_runs).and_raise(Harness::Client::TransportError))

      result = described_class.call(client: client)

      # A missing answer is not an empty run list. Treating it as one would fail every
      # live run whenever Rails boots while the harness is briefly down.
      expect(result).to(be_unreachable)
      expect(run.reload.status).to(eq('running'))
    end

    it 'does not fail live runs on a non-200' do
      run = create(:ai_run, session: session, status: 'running')

      result = described_class.call(client: client_reporting([], status: 503))

      expect(result).to(be_unreachable)
      expect(run.reload.status).to(eq('running'))
    end
  end

  describe 'the reconciliation cursor' do
    it 'records the harness store_seq for each reported run' do
      run = create(:ai_run, session: session, status: 'running')

      described_class.call(client: client_reporting([entry(run, store_seq: 41)]))

      expect(run.reload.harness_store_seq).to(eq(41))
    end
  end

  describe 'runs Rails cannot place' do
    it 'reports a run id with no Rails row instead of inventing one' do
      ghost = { 'run_id' => '999999', 'session_id' => session.id.to_s, 'lane' => 'main', 'store_seq' => 3 }

      result = described_class.call(client: client_reporting([ghost]))

      expect(result.unknown).to(eq(['999999']))
    end

    it 'reports a non-numeric run id rather than coercing it to row 0' do
      opaque = { 'run_id' => 'run_abc', 'session_id' => session.id.to_s, 'lane' => 'main', 'store_seq' => 1 }

      result = described_class.call(client: client_reporting([opaque]))

      # `"run_abc".to_i` is 0, so coercing gives a WHERE that looks like a real lookup,
      # matches nothing, and reports the harness's run as Rails row 0. The id has to
      # survive to the report AS ITSELF, which is what makes the log actionable.
      expect(result.unknown).to(eq(['run_abc']))
      expect(AiRun.exists?(id: 0)).to(be(false))
    end
  end
end
