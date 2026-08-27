# frozen_string_literal: true

require 'rails_helper'

RSpec.describe('POST /internal/events') do
  let(:session) { create(:session) }
  let(:ai_run) { create(:ai_run, session: session) }
  let(:secret) { 'test-shared-secret' }

  before { allow(ENV).to(receive(:fetch).and_call_original) }

  def with_secret
    allow(ENV).to(receive(:fetch).with('HARNESS_SHARED_SECRET', anything).and_return(secret))
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

  it 'rejects a user-actor element missing its participant id with 422 and ingests nothing' do
    with_secret
    bad = { session_id: session.id, type: 'chat_message', actor: { kind: 'user' },
            ts: '2026-06-28T20:11:05.123Z', payload: {} }
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

  # The projection check compares `max(store_seq)` and a digest over `(store_seq, type, seq)` triples
  # on BOTH sides, and filters `.where.not(store_seq: nil)`. So a dropped `store_seq` does not degrade
  # the check — it blinds it: Rails looks empty, every session reports `diverged: true`, and a real
  # divergence becomes indistinguishable from a healthy one. Found by running scenario S4 step 3
  # against a live session, where a freshly-ingested run reported
  # `rails: {high_water: 0, count: 0}` beside `harness: {high_water: 19, count: 16}`.
  #
  # The value was dropped by strong params: `permit_event` listed every other envelope field and not
  # this one, while `Events::Ingest#build_event` was already reading `attrs[:store_seq]`. Nothing in
  # this file asserted it, which is why it survived — 907 rows on the dev host, every one NULL.
  describe 'store_seq' do
    it 'is persisted, because the divergence check is built on it' do
      with_secret
      post('/internal/events',
           params: { events: [durable(seq: 1).merge(store_seq: 42)] }.to_json,
           headers: auth_headers)

      expect(response).to(have_http_status(:ok))
      expect(Event.last.store_seq).to(eq(42))
    end

    it 'survives a batch, so a high-water comparison sees the real maximum' do
      with_secret
      post('/internal/events',
           params: { events: [durable(seq: 1).merge(store_seq: 7),
                              durable(seq: 2).merge(store_seq: 9)] }.to_json,
           headers: auth_headers)

      expect(Event.where.not(store_seq: nil).maximum(:store_seq)).to(eq(9))
    end

    it 'stays nil for a Rails-originated event, which has no store position' do
      # `participant_joined` and `changeset_ready` are appended by Rails, not projected from the
      # harness record, so they legitimately carry none — which is why the check filters rather than
      # counting every row.
      Events::Append.call(session: session,
                          event: { type: 'chat_message', actor: { kind: 'system' },
                                   payload: { body: 'hi' } })

      expect(Event.last.store_seq).to(be_nil)
    end
  end
end
