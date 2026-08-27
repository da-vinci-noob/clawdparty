# frozen_string_literal: true

require 'rails_helper'

RSpec.describe('POST /api/sessions/:id/archive (owner hard-close)') do
  let(:session) { create(:session, status: 'active') }

  it 'lets an owner archive an active session (200 + status archived)' do
    join_as(session, role: 'owner')
    post("/api/sessions/#{session.id}/archive")

    expect(response).to(have_http_status(:ok))
    expect(response.parsed_body).to(include('id' => session.id.to_s, 'status' => 'archived'))
    expect(session.reload.status).to(eq('archived'))
  end

  it 'is idempotent: archiving an already-archived session is a 200 no-op' do
    session.update!(status: 'archived')
    join_as(session, role: 'owner')
    post("/api/sessions/#{session.id}/archive")

    expect(response).to(have_http_status(:ok))
    expect(response.parsed_body['status']).to(eq('archived'))
  end

  it 'refuses a non-owner participant with 403 and leaves the status unchanged' do
    join_as(session, role: 'editor')
    post("/api/sessions/#{session.id}/archive")

    expect(response).to(have_http_status(:forbidden))
    expect(session.reload.status).to(eq('active'))
  end

  it 'refuses a participant of another session with 404 (anti-enumeration)' do
    other = create(:session)
    join_as(other, role: 'owner')
    post("/api/sessions/#{session.id}/archive")

    expect(response).to(have_http_status(:not_found))
    expect(session.reload.status).to(eq('active'))
  end

  it 'refuses an unauthenticated request with 404' do
    post("/api/sessions/#{session.id}/archive")
    expect(response).to(have_http_status(:not_found))
  end

  # Archive is a hard close, so the worktree it created should not outlive it. Nothing
  # removed one before, so the mount root accumulated checkouts indistinguishable from live ones.
  describe('the session worktree') do
    def stub_worktree(outcome)
      manager = instance_double(Git::WorktreeManager, remove_worktree!: outcome)
      allow(Git::WorktreeManager).to(receive(:new).and_return(manager))
      manager
    end

    it 'is removed when the session is archived' do
      manager = stub_worktree(:removed)
      join_as(session, role: 'owner')
      post("/api/sessions/#{session.id}/archive")

      expect(manager).to(have_received(:remove_worktree!))
      expect(response.parsed_body['worktree']).to(eq('removed'))
    end

    it 'is KEPT when it holds unreviewed work, and says so' do
      stub_worktree(:kept_dirty)
      join_as(session, role: 'owner')
      post("/api/sessions/#{session.id}/archive")

      # An unreviewed changeset exists ONLY in the worktree, so removing one would destroy work
      # nobody approved or rejected. Reported rather than silent: the owner needs to know, and
      # `bin/worktrees` is how they deal with it.
      expect(response.parsed_body['worktree']).to(eq('kept_dirty'))
      expect(session.reload.status).to(eq('archived'))
    end

    it 'still archives when the worktree cannot be removed' do
      allow(Git::WorktreeManager).to(receive(:new).and_raise(Git::WorktreeManager::GitError, 'boom'))
      join_as(session, role: 'owner')
      post("/api/sessions/#{session.id}/archive")

      # A leftover directory is a cleanup task, not a reason to refuse a hard close.
      expect(response).to(have_http_status(:ok))
      expect(session.reload.status).to(eq('archived'))
      expect(response.parsed_body['worktree']).to(eq('failed'))
    end

    it 'does not look for one on a chat session, which never had a worktree' do
      chat = create(:session, status: 'active', mode: 'chat')
      allow(Git::WorktreeManager).to(receive(:new))
      join_as(chat, role: 'owner')
      post("/api/sessions/#{chat.id}/archive")

      expect(Git::WorktreeManager).not_to(have_received(:new))
      expect(response.parsed_body['worktree']).to(eq('not_applicable'))
    end
  end
end
