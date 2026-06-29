# frozen_string_literal: true

require 'rails_helper'

RSpec.describe('POST /internal/events') do
  let(:session) { create(:session) }
  let(:ai_run) { create(:ai_run, session: session) }
  let(:secret) { 'test-shared-secret' }

  before { allow(ENV).to(receive(:fetch).and_call_original) }

  def with_secret
    allow(ENV).to(receive(:fetch).with('SIDECAR_SHARED_SECRET', anything).and_return(secret))
  end

  def auth_headers(token = secret)
    { 'Authorization' => "Bearer #{token}", 'Content-Type' => 'application/json' }
  end

  def durable(seq:, type: 'ai_text')
    { id: nil, session_id: session.id, ai_run_id: ai_run.id, seq: seq, type: type,
      actor: { kind: 'claude' }, ts: '2026-06-28T20:11:05.123Z', payload: {} }
  end

  it 'rejects a missing/invalid bearer token with 401 and ingests nothing' do
    with_secret
    expect do
      post('/internal/events', params: { events: [durable(seq: 1)] }.to_json,
                               headers: auth_headers('wrong'))
    end.not_to(change(Event, :count))
    expect(response).to(have_http_status(:unauthorized))
  end

  it 'ingests an authenticated batch via Events::Ingest and reports counts' do
    with_secret
    post('/internal/events', params: { events: [durable(seq: 1), durable(seq: 2)] }.to_json,
                             headers: auth_headers)
    expect(response).to(have_http_status(:ok))
    expect(response.parsed_body).to(eq({ 'accepted' => 2, 'skipped' => 0 }))
  end

  it 'is idempotent over the wire: a re-POSTed batch reports skipped duplicates' do
    with_secret
    body = { events: [durable(seq: 1), durable(seq: 2)] }.to_json
    post('/internal/events', params: body, headers: auth_headers)
    expect do
      post('/internal/events', params: body, headers: auth_headers)
    end.not_to(change(Event, :count))
    expect(response).to(have_http_status(:ok))
    expect(response.parsed_body).to(eq({ 'accepted' => 0, 'skipped' => 2 }))
  end

  it 'accepts a valid ephemeral element with null id/seq (not a 422)' do
    with_secret
    ephemeral = { id: nil, session_id: session.id, ai_run_id: ai_run.id, seq: nil,
                  type: 'ai_text_delta', actor: { kind: 'claude' },
                  ts: '2026-06-28T20:11:05.123Z', payload: {} }
    post('/internal/events', params: { events: [ephemeral] }.to_json, headers: auth_headers)
    expect(response).to(have_http_status(:ok))
  end

  it 'rejects a malformed batch (element missing type) with 422 and ingests nothing' do
    with_secret
    bad = { session_id: session.id, actor: { kind: 'claude' }, ts: '2026-06-28T20:11:05.123Z' }
    expect do
      post('/internal/events', params: { events: [bad] }.to_json, headers: auth_headers)
    end.not_to(change(Event, :count))
    expect(response).to(have_http_status(:unprocessable_content))
  end

  it 'ingests best-effort: a parseable batch with one duplicate still ingests the rest' do
    with_secret
    post('/internal/events', params: { events: [durable(seq: 1)] }.to_json, headers: auth_headers)
    post('/internal/events', params: { events: [durable(seq: 1), durable(seq: 2)] }.to_json,
                             headers: auth_headers)
    expect(response).to(have_http_status(:ok))
    expect(response.parsed_body).to(eq({ 'accepted' => 1, 'skipped' => 1 }))
  end
end
