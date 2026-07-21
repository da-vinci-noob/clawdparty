# frozen_string_literal: true

require 'rails_helper'

RSpec.describe('GET /api/sessions (list the caller\'s sessions)') do
  it 'returns the sessions the caller hosts or participates in, newest activity first' do
    mine_owned = create(:session, title: 'Owned', last_activity_at: 3.hours.ago)
    joined = create(:session, title: 'Joined', last_activity_at: 1.hour.ago)
    create(:session, title: 'Someone else', last_activity_at: 10.minutes.ago)

    # join_as sets the cookie as the SAME user across calls in one example, so
    # the caller becomes owner of `mine_owned` and reviewer of `joined`.
    join_as(mine_owned, role: 'owner')
    join_as(joined, role: 'reviewer')

    get('/api/sessions')

    expect(response).to(have_http_status(:ok))
    titles = response.parsed_body.pluck('title')
    expect(titles).to(eq(%w[Joined Owned])) # newest activity first, excludes the other user's session
  end

  it 'serializes each row with id (string), title, mode, status, my_role, and timestamps' do
    session = create(:session, title: 'Row shape', mode: 'chat', last_activity_at: 1.hour.ago)
    join_as(session, role: 'reviewer')

    get('/api/sessions')

    row = response.parsed_body.sole
    expect(row).to(include(
                     'id' => session.id.to_s,
                     'title' => 'Row shape',
                     'mode' => 'chat',
                     'status' => 'active',
                     'my_role' => 'reviewer',
                     'owned' => false
                   ))
    expect(row['last_activity_at']).to(be_present)
    expect(row['created_at']).to(be_present)
  end

  it 'lists an archived session with status archived (the web maps this to the revoked badge)' do
    session = create(:session, status: 'archived', last_activity_at: 1.hour.ago)
    join_as(session, role: 'owner')

    get('/api/sessions')

    expect(response.parsed_body.sole['status']).to(eq('archived'))
  end

  it 'shows a session the caller both hosts and owns exactly once, with my_role owner and owned true' do
    session = create(:session, last_activity_at: 1.hour.ago)
    participant = join_as(session, role: 'owner')
    session.update!(host: participant.user)

    get('/api/sessions')

    rows = response.parsed_body.select { |row| row['id'] == session.id.to_s }
    expect(rows.length).to(eq(1))
    expect(rows.first).to(include('my_role' => 'owner', 'owned' => true))
  end

  it 'marks a joined (non-hosted) session as owned false so the UI can group it under Joined' do
    session = create(:session, last_activity_at: 1.hour.ago)
    join_as(session, role: 'reviewer')

    get('/api/sessions')

    expect(response.parsed_body.sole['owned']).to(be(false))
  end

  it 'refuses an unauthenticated request with 404 (anti-enumeration via require_user)' do
    get('/api/sessions')
    expect(response).to(have_http_status(:not_found))
  end
end
