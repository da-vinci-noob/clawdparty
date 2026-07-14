# frozen_string_literal: true

require 'rails_helper'

RSpec.describe('GET /api/sessions/:session_id/events (backfill)') do
  let(:session) { create(:session) }
  let(:ai_run) { create(:ai_run, session: session) }

  def seed_events(count)
    count.times.map do |i|
      create(:event, session: session, ai_run: ai_run, seq: i + 1, event_type: 'ai_text')
    end
  end

  it 'returns 200 with an ordered envelope array of events with id > cursor' do
    # Join FIRST so its participant_joined event has the lowest id (below the
    # cursor), leaving the assertion about the seeded events unaffected.
    join_as(session, role: 'viewer')
    events = seed_events(3)

    get("/api/sessions/#{session.id}/events", params: { after: events.first.id })

    expect(response).to(have_http_status(:ok))
    ids = response.parsed_body.pluck('id')
    expect(ids).to(eq([events[1].id, events[2].id]))
    expect(ids).to(eq(ids.sort))
    expect(response.parsed_body.first['session_id']).to(eq(session.id.to_s))
  end

  it 'returns all events when no cursor is given (incl. the join event)' do
    join_as(session) # emits one participant_joined
    events = seed_events(2)
    get("/api/sessions/#{session.id}/events")
    expect(response.parsed_body.pluck('id')).to(include(*events.map(&:id)))
    expect(response.parsed_body.size).to(eq(3)) # 2 seeded + participant_joined
  end

  it 'refuses cross-session access with 404 (not 403)' do
    other = create(:session)
    create(:event, session: other, ai_run: create(:ai_run, session: other), seq: 1)
    join_as(session) # participant of `session`, NOT `other`

    get("/api/sessions/#{other.id}/events")
    expect(response).to(have_http_status(:not_found))
    expect(response.parsed_body['errors']).to(be_present)
  end

  it 'rejects an unauthenticated request with 404' do
    get("/api/sessions/#{session.id}/events")
    expect(response).to(have_http_status(:not_found))
  end
end
