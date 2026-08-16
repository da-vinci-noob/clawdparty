# frozen_string_literal: true

require 'rails_helper'

RSpec.describe('POST /internal/harness/heartbeat') do
  let(:secret) { 'test-shared-secret' }

  before do
    allow(ENV).to(receive(:fetch).and_call_original)
    allow(ENV).to(receive(:fetch).with('HARNESS_SHARED_SECRET', anything).and_return(secret))
  end

  def headers(token = secret)
    { 'Authorization' => "Bearer #{token}", 'Content-Type' => 'application/json' }
  end

  it 'acknowledges a valid bearer heartbeat with 200 { ok: true }' do
    post('/internal/harness/heartbeat', params: { active_run_ids: %w[run_1 run_2] }.to_json,
                                        headers: headers)
    expect(response).to(have_http_status(:ok))
    expect(response.parsed_body).to(eq({ 'ok' => true }))
  end

  it 'rejects a missing/invalid bearer with 401' do
    post('/internal/harness/heartbeat', params: { active_run_ids: [] }.to_json,
                                        headers: headers('wrong'))
    expect(response).to(have_http_status(:unauthorized))
  end

  describe 'projection lag' do
    let(:session) { create(:session) }
    let(:run) { create(:ai_run, session: session, status: 'running') }

    def beat(high_water)
      post('/internal/harness/heartbeat',
           params: { active_run_ids: [run.id.to_s], store_seq_high_water: high_water }.to_json,
           headers: headers)
    end

    it 'records the harness cursor per run, so lag is visible without polling' do
      beat({ run.id.to_s => 42 })

      # `Harness::Reconcile` records this at boot, which answers "how far behind was I when
      # I started" and nothing about the next hour. Comparing it to MAX(events.store_seq) is
      # what makes lag observable continuously.
      expect(run.reload.harness_store_seq).to(eq(42))
    end

    it 'advances the cursor on a later beat' do
      beat({ run.id.to_s => 42 })
      beat({ run.id.to_s => 99 })

      expect(run.reload.harness_store_seq).to(eq(99))
    end

    it 'ignores a non-numeric run id instead of coercing it' do
      beat({ 'run_abc' => 7, run.id.to_s => 12 })

      # `'run_abc'.to_i` is 0, so coercion would write the cursor onto run 0 or, worse,
      # silently onto a row that has nothing to do with it. The harness's ids ARE Rails
      # ids; a non-numeric one means the two disagree about what a run is.
      expect(run.reload.harness_store_seq).to(eq(12))
      expect(response).to(have_http_status(:ok))
    end

    it 'still acknowledges a heartbeat that omits the cursors' do
      post('/internal/harness/heartbeat', params: { active_run_ids: [run.id.to_s] }.to_json,
                                          headers: headers)

      # An older harness, or one with no active runs. Must not 500 — a heartbeat that
      # fails looks exactly like a harness that died, and Rails would fail live runs.
      expect(response).to(have_http_status(:ok))
      expect(run.reload.harness_store_seq).to(be_nil)
    end
  end
end
