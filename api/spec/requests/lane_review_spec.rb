# frozen_string_literal: true

require 'rails_helper'

# each lane is reviewed independently, and a reject in one lane
# does not leak into another.
#
# is the load-bearing one, and it is why there is a worktree per lane. Reject runs
# `git reset --hard HEAD && git clean -fd`. With a SHARED worktree, rejecting lane A would delete
# lane B's uncommitted work — work nobody reviewed and nobody can recover. So "does not leak" is not
# a tidiness property here; it is the difference between a revert and data loss.
RSpec.describe('Per-lane review') do
  let(:session) { create(:session) }

  # A recording client, mirroring `spec/services/runs/start_spec.rb`: the payload is the thing
  # under test, so it has to be captured rather than stubbed away.
  let(:posted) { [] }
  let(:client) do
    p = posted
    Class.new do
      define_method(:start_run) do |payload|
        p << payload
        Harness::Client::Result.new(status: 202, body: { 'status' => 'running' })
      end
    end.new
  end

  def start_in(lane)
    Runs::Start.call(
      session: session, requested_by: session.participants.first, prompt: 'go', model: 'm',
      lane: lane, client: client,
      worktree: instance_double(Git::WorktreeManager, ensure_worktree!: '/w', dirty?: false,
                                                      base_sha: '0' * 40)
    )
  end

  def run_in(lane, status: 'awaiting_review')
    create(:ai_run, session: session, status: status, lane: lane)
  end

  def events_of(run, type)
    session.events.where(ai_run_id: run.id, event_type: type)
  end

  describe 'two lanes each awaiting review' do
    it 'lets both exist at once, which the per-session index used to forbid' do
      main = run_in('main')
      review = run_in('review')

      # The DB index is the backstop and it moved from (session) to (session, lane) — before that
      # migration the second create raised RecordNotUnique and  was impossible at the schema.
      expect([main.reload.status, review.reload.status]).to(eq(%w[awaiting_review awaiting_review]))
    end

    it 'approves one lane without touching the other' do
      main = run_in('main')
      review = run_in('review')
      join_as(session, role: 'owner')
      allow_any_instance_of(Git::WorktreeManager).to(receive(:commit!).and_return('sha'))

      post("/api/runs/#{main.id}/approve")

      expect(response).to(have_http_status(:ok))
      expect(main.reload.status).to(eq('approved'))
      # The other lane is still awaiting its own review — approving one changeset must not settle
      # a changeset the reviewer never looked at.
      expect(review.reload.status).to(eq('awaiting_review'))
    end

    it 'rejects one lane without touching the other' do
      main = run_in('main')
      review = run_in('review')
      join_as(session, role: 'owner')
      allow_any_instance_of(Git::WorktreeManager).to(receive(:reset_hard!).and_return(true))

      post("/api/runs/#{main.id}/reject")

      expect(response).to(have_http_status(:ok))
      expect(main.reload.status).to(eq('rejected'))
      expect(review.reload.status).to(eq('awaiting_review'))
    end

    it 'appends each lane its own changeset event, attributed to its own run' do
      main = run_in('main')
      review = run_in('review')
      join_as(session, role: 'owner')
      allow_any_instance_of(Git::WorktreeManager).to(receive(:commit!).and_return('sha'))
      allow_any_instance_of(Git::WorktreeManager).to(receive(:reset_hard!).and_return(true))

      post("/api/runs/#{main.id}/approve")
      post("/api/runs/#{review.id}/reject")

      expect(events_of(main, 'changeset_approved').count).to(eq(1))
      expect(events_of(review, 'changeset_rejected').count).to(eq(1))
      # And NOT crossed: the feed is per session, so an event attributed to the wrong run would
      # tell the room the wrong lane was approved.
      expect(events_of(main, 'changeset_rejected').count).to(eq(0))
      expect(events_of(review, 'changeset_approved').count).to(eq(0))
    end
  end

  describe 'each lane reviews its OWN worktree' do
    it 'resolves the reviewed run\'s lane, not the session default' do
      review = run_in('review')
      join_as(session, role: 'owner')

      allow(Git::WorktreeManager).to(receive(:new).and_return(
                                       instance_double(Git::WorktreeManager, commit!: 'sha')
                                     ))

      post("/api/runs/#{review.id}/approve")

      # The wiring that matters. Approving a `review`-lane run must commit the `review` tree; with
      # the session-default lane it would commit `main`'s — someone else's work, under this
      # reviewer's name.
      expect(Git::WorktreeManager).to(have_received(:new).with(session, lane: 'review'))
      expect(response).to(have_http_status(:ok))
    end

    it 'reverts the reviewed run\'s lane on reject, never another' do
      review = run_in('review')
      join_as(session, role: 'owner')

      allow(Git::WorktreeManager).to(receive(:new).and_return(
                                       instance_double(Git::WorktreeManager, reset_hard!: true)
                                     ))

      post("/api/runs/#{review.id}/reject")

      # The dangerous direction: `reset_hard!` on the wrong tree destroys unreviewed work.
      expect(Git::WorktreeManager).to(have_received(:new).with(session, lane: 'review'))
      expect(response).to(have_http_status(:ok))
    end
  end

  describe 'a reject severs only its own lane\'s context' do
    before { join_as(session, role: 'owner') }

    it 'sends resume_context false for the rejected lane itself' do
      create(:ai_run, session: session, status: 'rejected', lane: 'main')
      start_in('main')

      # The existing rule, unchanged: the recorded conversation describes edits that reject
      # reverted, so resuming it would have Claude reason about files it cannot see.
      expect(posted.last[:resume_context]).to(be(false))
    end

    it 'DOES resume the other lane, whose history was never rejected' do
      create(:ai_run, session: session, status: 'rejected', lane: 'main')
      create(:ai_run, session: session, status: 'completed_clean', lane: 'review')
      start_in('review')

      # The leak this prevents: reading the session's latest run across ALL lanes would let main's
      # rejection sever review's context, and would resume main's conversation into review.
      expect(posted.last[:resume_context]).to(be(true))
    end

    it 'carries the lane on the payload, so the harness resumes the right stream' do
      start_in('review')
      expect(posted.last[:lane]).to(eq('review'))
    end
  end

  describe 'one active run per LANE, not per session' do
    before { join_as(session, role: 'owner') }

    it 'refuses a second run in the SAME lane' do
      start_in('main')
      expect { start_in('main') }.to(raise_error(Runs::Start::ActiveRunExists))
    end

    it 'allows a concurrent run in a DIFFERENT lane' do
      start_in('main')
      expect { start_in('review') }.not_to(raise_error)
      expect(session.ai_runs.active.pluck(:lane).sort).to(eq(%w[main review]))
    end
  end

  describe 'an invalid lane name' do
    before { join_as(session, role: 'owner') }

    it 'is refused with 422 rather than escaping the worktree root' do
      # `lane` reaches a filesystem path AND a git branch name, and the controller forwards
      # `params[:lane]` straight through — so this is the only thing standing between a client and
      # a worktree written outside `.clawdparty/worktrees`.
      post("/api/sessions/#{session.id}/runs", params: { prompt: 'go', lane: '../evil' }, as: :json)

      expect(response).to(have_http_status(:unprocessable_content))
      expect(response.parsed_body['errors'].first['message']).to(match(/lane/i))
    end

    it 'names the rule, so the caller can fix it' do
      post("/api/sessions/#{session.id}/runs", params: { prompt: 'go', lane: 'Not Valid' }, as: :json)

      expect(response.parsed_body['errors'].first['message']).to(match(/lowercase/i))
    end

    it 'creates no run when the lane is refused' do
      expect do
        post("/api/sessions/#{session.id}/runs", params: { prompt: 'go', lane: 'a/b' }, as: :json)
      end.not_to(change(AiRun, :count))
    end
  end
end
