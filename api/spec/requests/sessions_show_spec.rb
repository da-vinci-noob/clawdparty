# frozen_string_literal: true

require 'rails_helper'

# The session view could not read the session it was displaying: routes exposed
# index/create/update only, so the web had no way to learn a session's `mode`. The
# consequence was not cosmetic — a `chat` session (no worktree, no changeset, so no
# approve/reject by design) looked exactly like a `review` session that had produced no
# changes, and the absence of review read as a bug.
RSpec.describe('GET /api/sessions/:id') do
  let(:session) { create(:session, mode: 'chat', repository_path: '/repo/proj') }

  it 'returns the mode and working directory to the owner' do
    join_as(session, role: 'owner')
    get("/api/sessions/#{session.id}")

    expect(response).to(have_http_status(:ok))
    expect(response.parsed_body).to(include('id' => session.id.to_s, 'mode' => 'chat',
                                            'repository_path' => '/repo/proj'))
  end

  it 'reports review mode faithfully' do
    review = create(:session, mode: 'review')
    join_as(review, role: 'owner')
    get("/api/sessions/#{review.id}")

    expect(response.parsed_body['mode']).to(eq('review'))
  end

  # EVERY role, down to viewer: the mode decides whether the page renders a review
  # affordance at all, so a viewer who cannot read it sees the same ambiguous screen the
  # missing endpoint caused.
  %w[owner editor reviewer viewer].each do |role|
    it "lets a #{role} read it" do
      join_as(session, role: role)
      get("/api/sessions/#{session.id}")
      expect(response).to(have_http_status(:ok))
    end
  end

  it 'refuses a participant of another session with 404 (anti-enumeration)' do
    join_as(create(:session), role: 'owner')
    get("/api/sessions/#{session.id}")
    expect(response).to(have_http_status(:not_found))
  end

  it 'refuses an unauthenticated request with 404' do
    get("/api/sessions/#{session.id}")
    expect(response).to(have_http_status(:not_found))
  end

  it 'refuses an unknown session with 404' do
    join_as(session, role: 'owner')
    get('/api/sessions/999999')
    expect(response).to(have_http_status(:not_found))
  end
end
