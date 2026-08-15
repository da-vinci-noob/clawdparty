# frozen_string_literal: true

require 'rails_helper'

RSpec.describe(Harness::HealthcheckJob) do
  let(:session) { create(:session) }

  def run_with_heartbeat(status:, heartbeat:)
    create(:ai_run, session: session, status: status).tap do |run|
      run.update_column(:last_heartbeat_at, heartbeat) # rubocop:disable Rails/SkipsModelValidations
    end
  end

  describe 'sweeping stale runs' do
    it 'fails a running run whose heartbeat is older than the threshold' do
      run = run_with_heartbeat(status: 'running', heartbeat: 20.seconds.ago)

      expect { described_class.perform_now }.to(change { run.reload.status }.from('running').to('failed'))
    end

    it 'appends a run_failed event attributed to the system' do
      run = run_with_heartbeat(status: 'running', heartbeat: 20.seconds.ago)

      expect { described_class.perform_now }.to(change(Event, :count).by(1))

      event = Event.order(:id).last
      expect(event.event_type).to(eq('run_failed'))
      expect(event.actor_kind).to(eq('system'))
      expect(event.ai_run_id).to(eq(run.id))
      expect(event.seq).to(eq(1))
    end

    it 'fails a queued run the harness never acknowledged' do
      run = create(:ai_run, session: session, status: 'queued')
      run.update_column(:created_at, 20.seconds.ago) # rubocop:disable Rails/SkipsModelValidations

      expect { described_class.perform_now }.to(change { run.reload.status }.to('failed'))
    end

    it 'leaves a run whose heartbeat is fresh' do
      run = run_with_heartbeat(status: 'running', heartbeat: 2.seconds.ago)

      expect { described_class.perform_now }.not_to(change { run.reload.status })
    end

    it 'leaves a freshly created queued run that has never been heartbeaten' do
      run = create(:ai_run, session: session, status: 'queued')

      expect { described_class.perform_now }.not_to(change { run.reload.status })
    end

    it 'does not re-fail an already terminal run' do
      run = run_with_heartbeat(status: 'failed', heartbeat: 10.minutes.ago)

      expect { described_class.perform_now }.not_to(change(Event, :count))
      expect(run.reload.status).to(eq('failed'))
    end
  end

  # The regression guard for the exclusion in HealthcheckJob::SWEEPABLE_STATUSES:
  # awaiting_review is in AiRun::ACTIVE_STATUSES but the harness has already finished
  # it, so it will never appear in a heartbeat again.
  describe 'awaiting_review' do
    it 'is never failed, no matter how old its heartbeat is' do
      run = run_with_heartbeat(status: 'awaiting_review', heartbeat: 1.hour.ago)

      expect { described_class.perform_now }.not_to(change { run.reload.status })
      expect(run.reload.status).to(eq('awaiting_review'))
    end

    it 'is never failed when it has no heartbeat at all' do
      run = create(:ai_run, session: session, status: 'awaiting_review')
      run.update_column(:created_at, 1.hour.ago) # rubocop:disable Rails/SkipsModelValidations

      expect { described_class.perform_now }.not_to(change { run.reload.status })
    end

    it 'is excluded from the sweepable set' do
      expect(described_class::SWEEPABLE_STATUSES).not_to(include('awaiting_review'))
      expect(AiRun::ACTIVE_STATUSES).to(include('awaiting_review'))
    end
  end

  describe 'scoping' do
    it 'sweeps every stale run across sessions in one pass' do
      other = create(:session)
      a = run_with_heartbeat(status: 'running', heartbeat: 30.seconds.ago)
      b = create(:ai_run, session: other, status: 'running')
      b.update_column(:last_heartbeat_at, 30.seconds.ago) # rubocop:disable Rails/SkipsModelValidations

      described_class.perform_now

      expect([a.reload.status, b.reload.status]).to(eq(%w[failed failed]))
    end
  end
end
