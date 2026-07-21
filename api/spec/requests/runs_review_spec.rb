# frozen_string_literal: true

require 'rails_helper'

RSpec.describe('Run review (approve / reject)') do
  let(:session) { create(:session) }

  def awaiting_run
    create(:ai_run, session: session, status: 'awaiting_review')
  end

  def events_of(run, type)
    session.events.where(ai_run_id: run.id, event_type: type)
  end

  describe 'POST /api/runs/:id/approve' do
    it 'lets an owner approve an awaiting_review run (200 + approved + changeset_approved event + commit)' do
      participant = join_as(session, role: 'owner')
      run = awaiting_run
      # Approve COMMITS the changeset onto the session branch (keeps the work AND
      # leaves a clean tree so the next fresh run is not blocked as dirty).
      expect_any_instance_of(Git::WorktreeManager).to(receive(:commit!))
      expect { post("/api/runs/#{run.id}/approve") }
        .to(change { events_of(run, 'changeset_approved').count }.by(1))
      expect(response).to(have_http_status(:ok))
      expect(response.parsed_body['status']).to(eq('approved'))
      expect(run.reload.status).to(eq('approved'))
      expect(run.reviewed_by_id).to(eq(participant.id))
    end

    %w[editor reviewer].each do |role|
      it "lets a #{role} approve an awaiting_review run (200 + approved + event + commit)" do
        participant = join_as(session, role: role)
        run = awaiting_run
        expect_any_instance_of(Git::WorktreeManager).to(receive(:commit!))
        expect { post("/api/runs/#{run.id}/approve") }
          .to(change { events_of(run, 'changeset_approved').count }.by(1))
        expect(response).to(have_http_status(:ok))
        expect(run.reload.status).to(eq('approved'))
        expect(run.reviewed_by_id).to(eq(participant.id))
      end
    end

    it 'denies a viewer with 403 and leaves the run unchanged' do
      join_as(session, role: 'viewer')
      run = awaiting_run
      expect { post("/api/runs/#{run.id}/approve") }
        .not_to(change { events_of(run, 'changeset_approved').count })
      expect(response).to(have_http_status(:forbidden))
      expect(run.reload.status).to(eq('awaiting_review'))
    end

    it 'refuses a cross-session / non-participant run with 404' do
      other = create(:session)
      run = create(:ai_run, session: other, status: 'awaiting_review')
      join_as(session, role: 'owner') # participant of `session`, not `other`
      post("/api/runs/#{run.id}/approve")
      expect(response).to(have_http_status(:not_found))
      expect(run.reload.status).to(eq('awaiting_review'))
    end

    it 'refuses approving a run that is not awaiting_review with 409' do
      join_as(session, role: 'owner')
      run = create(:ai_run, session: session, status: 'running')
      post("/api/runs/#{run.id}/approve")
      expect(response).to(have_http_status(:conflict))
      expect(run.reload.status).to(eq('running'))
    end
  end

  describe 'POST /api/runs/:id/reject' do
    it 'lets an owner reject an awaiting_review run (200 + rejected + event + worktree reset)' do
      participant = join_as(session, role: 'owner')
      run = awaiting_run
      expect_any_instance_of(Git::WorktreeManager).to(receive(:reset_hard!))
      expect { post("/api/runs/#{run.id}/reject") }
        .to(change { events_of(run, 'changeset_rejected').count }.by(1))
      expect(response).to(have_http_status(:ok))
      expect(response.parsed_body['status']).to(eq('rejected'))
      expect(run.reload.status).to(eq('rejected'))
      expect(run.reviewed_by_id).to(eq(participant.id))
    end

    %w[editor reviewer].each do |role|
      it "lets a #{role} reject an awaiting_review run (200 + rejected + event + worktree reset)" do
        participant = join_as(session, role: role)
        run = awaiting_run
        expect_any_instance_of(Git::WorktreeManager).to(receive(:reset_hard!))
        expect { post("/api/runs/#{run.id}/reject") }
          .to(change { events_of(run, 'changeset_rejected').count }.by(1))
        expect(response).to(have_http_status(:ok))
        expect(run.reload.status).to(eq('rejected'))
        expect(run.reviewed_by_id).to(eq(participant.id))
      end
    end

    it 'denies a viewer with 403 and leaves the run unchanged' do
      join_as(session, role: 'viewer')
      run = awaiting_run
      expect { post("/api/runs/#{run.id}/reject") }
        .not_to(change { events_of(run, 'changeset_rejected').count })
      expect(response).to(have_http_status(:forbidden))
      expect(run.reload.status).to(eq('awaiting_review'))
    end

    it 'refuses a cross-session / non-participant run with 404' do
      other = create(:session)
      run = create(:ai_run, session: other, status: 'awaiting_review')
      join_as(session, role: 'owner')
      post("/api/runs/#{run.id}/reject")
      expect(response).to(have_http_status(:not_found))
      expect(run.reload.status).to(eq('awaiting_review'))
    end

    it 'refuses rejecting a run that is not awaiting_review with 409 (no worktree reset)' do
      join_as(session, role: 'owner')
      run = create(:ai_run, session: session, status: 'completed_clean')
      expect_any_instance_of(Git::WorktreeManager).not_to(receive(:reset_hard!))
      post("/api/runs/#{run.id}/reject")
      expect(response).to(have_http_status(:conflict))
      expect(run.reload.status).to(eq('completed_clean'))
    end
  end
end
