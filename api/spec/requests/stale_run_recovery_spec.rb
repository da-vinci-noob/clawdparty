# frozen_string_literal: true

require 'rails_helper'

# The bug this feature exists to fix: a harness crash left a run active forever, and
# index_ai_runs_one_active_per_session then refused every subsequent run — bricking the
# session permanently. Reproduce it, then prove the sweep releases the session.
RSpec.describe('Stale run recovery') do
  let(:session) { create(:session) }

  before do
    wt_path = "/repo/.clawdparty/worktrees/session-#{session.id}"
    allow_any_instance_of(Git::WorktreeManager)
      .to(receive_messages(ensure_worktree!: wt_path, dirty?: false, base_sha: '0' * 40))
    allow_any_instance_of(Harness::Client).to(receive(:start_run)
      .and_return(Harness::Client::Result.new(status: 202, body: {})))
  end

  def start_run
    post("/api/sessions/#{session.id}/runs", params: { prompt: 'build it', model: 'm' })
  end

  def stranded_run
    create(:ai_run, session: session, status: 'running').tap do |run|
      run.update_column(:last_heartbeat_at, 30.seconds.ago) # rubocop:disable Rails/SkipsModelValidations
    end
  end

  it 'refuses a new run while the stranded run is still active' do
    stranded_run
    join_as(session, role: 'owner')

    expect { start_run }.not_to(change(AiRun, :count))
    expect(response).to(have_http_status(:conflict))
  end

  it 'accepts a new run once the sweep has failed the stranded run' do
    run = stranded_run
    Harness::HealthcheckJob.perform_now
    expect(run.reload.status).to(eq('failed'))

    join_as(session, role: 'owner')

    expect { start_run }.to(change(AiRun, :count).by(1))
    expect(response).to(have_http_status(:accepted))
  end

  it 'still refuses a new run when the active run is awaiting review' do
    run = create(:ai_run, session: session, status: 'awaiting_review')
    run.update_column(:last_heartbeat_at, 1.hour.ago) # rubocop:disable Rails/SkipsModelValidations
    Harness::HealthcheckJob.perform_now

    expect(run.reload.status).to(eq('awaiting_review'))

    join_as(session, role: 'owner')
    expect { start_run }.not_to(change(AiRun, :count))
    expect(response).to(have_http_status(:conflict))
  end
end
