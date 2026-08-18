# frozen_string_literal: true

require 'rails_helper'

# Projection repair and audit, owner-gated.
#
# `rederive` mutates the projection, so it sits behind `manage_session` rather than being
# available to anyone who can approve a diff. `check` is read-only and gated the same way,
# because its output describes the health of the record and is an operator concern.
RSpec.describe('Projection repair') do
  let(:session) { create(:session) }
  let(:ai_run) { create(:ai_run, session: session) }

  def entry(store_seq:, seq:)
    { 'store_seq' => store_seq, 'run_id' => ai_run.id, 'seq' => seq, 'type' => 'ai_text',
      'actor_kind' => 'claude', 'actor_id' => nil, 'ts_ms' => 1_700_000_000_000 + store_seq,
      'payload' => { 'text' => 'hi' }, 'blocks' => nil, 'on_surface' => 0, 'emitted' => 1 }
  end

  before do
    allow_any_instance_of(Harness::Client).to(receive(:list_entries).and_return(
                                                Harness::Client::Result.new(
                                                  status: 200,
                                                  body: { 'entries' => [entry(store_seq: 1, seq: 1)] }
                                                )
                                              ))
  end

  describe 'POST /api/sessions/:id/projection/rederive (role matrix)' do
    it 'allows the owner' do
      join_as(session, role: 'owner')

      expect { post("/api/sessions/#{session.id}/projection/rederive") }
        .to(change(Event, :count).by(1))
      expect(response).to(have_http_status(:ok))
      expect(response.parsed_body).to(include('accepted' => 1, 'reset' => false))
    end

    it 'refuses every other role, including editor and reviewer' do
      %w[editor reviewer viewer].each do |role|
        other = create(:session)
        join_as(other, role: role)

        post("/api/sessions/#{other.id}/projection/rederive")

        # Rebuilding a projection is not a review action. An editor can drive Claude and an
        # editor still cannot rewrite the room's history.
        expect(response).to(have_http_status(:forbidden), "#{role} was allowed to re-derive")
      end
    end

    it 'refuses a non-participant with 404, never revealing the session exists' do
      post("/api/sessions/#{session.id}/projection/rederive")

      expect(response).to(have_http_status(:not_found))
    end

    it 'requires `reset` to be asked for explicitly' do
      join_as(session, role: 'owner')
      create(:event, session: session, ai_run: ai_run, seq: 5, store_seq: 5)

      post("/api/sessions/#{session.id}/projection/rederive")

      # Default is gap-fill. A default of reset would make an innocent-looking repair
      # delete the session's rows and invalidate every connected client's cursor.
      expect(response.parsed_body['reset']).to(be(false))
      expect(Event.where(session: session, store_seq: 5)).to(exist)
    end

    it 'resets when asked' do
      join_as(session, role: 'owner')
      create(:event, session: session, ai_run: ai_run, seq: 5, store_seq: 5)

      post("/api/sessions/#{session.id}/projection/rederive", params: { reset: true })

      expect(response.parsed_body['reset']).to(be(true))
      # The store_seq 5 row is gone and rebuilt as 1; the `participant_joined` that `join_as`
      # appended survives with a null store_seq, because no harness entry could put it back.
      #
      # Ordered by id, not bare `pluck`: a reset deletes and re-inserts, so physical row order is
      # not the insertion order and the unordered version failed intermittently.
      expect(Event.where(session: session).order(:id).pluck(:store_seq)).to(eq([nil, 1]))
    end
  end

  describe 'GET /api/sessions/:id/projection/check' do
    it 'reports both sides so a divergence can be read, not guessed' do
      join_as(session, role: 'owner')

      get("/api/sessions/#{session.id}/projection/check")

      expect(response).to(have_http_status(:ok))
      body = response.parsed_body
      expect(body['diverged']).to(be(true))
      expect(body['rails']['high_water']).to(eq(0))
      expect(body['harness']['high_water']).to(eq(1))
    end

    it 'reports ok once the projection matches' do
      join_as(session, role: 'owner')
      post("/api/sessions/#{session.id}/projection/rederive", params: { reset: true })

      get("/api/sessions/#{session.id}/projection/check")

      expect(response.parsed_body['diverged']).to(be(false))
      expect(response.parsed_body['reason']).to(be_nil)
    end

    it 'is owner-only too' do
      join_as(session, role: 'reviewer')

      get("/api/sessions/#{session.id}/projection/check")

      expect(response).to(have_http_status(:forbidden))
    end
  end
end
