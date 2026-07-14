# frozen_string_literal: true

require 'rails_helper'

RSpec.describe('POST /internal/sidecar/heartbeat') do
  let(:secret) { 'test-shared-secret' }

  before do
    allow(ENV).to(receive(:fetch).and_call_original)
    allow(ENV).to(receive(:fetch).with('SIDECAR_SHARED_SECRET', anything).and_return(secret))
  end

  def headers(token = secret)
    { 'Authorization' => "Bearer #{token}", 'Content-Type' => 'application/json' }
  end

  it 'acknowledges a valid bearer heartbeat with 200 { ok: true }' do
    post('/internal/sidecar/heartbeat', params: { active_run_ids: %w[run_1 run_2] }.to_json,
                                        headers: headers)
    expect(response).to(have_http_status(:ok))
    expect(response.parsed_body).to(eq({ 'ok' => true }))
  end

  it 'rejects a missing/invalid bearer with 401' do
    post('/internal/sidecar/heartbeat', params: { active_run_ids: [] }.to_json,
                                        headers: headers('wrong'))
    expect(response).to(have_http_status(:unauthorized))
  end
end
