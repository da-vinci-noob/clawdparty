# frozen_string_literal: true

require 'rails_helper'

RSpec.describe(Runs::Finalize) do
  let(:session) { create(:session) }
  let(:run) { create(:ai_run, session: session, status: 'queued') }

  let(:participant) { create(:participant, session: session, role: 'owner') }

  # Ingest a run-lifecycle event for `run` (the sidecar-emitted path). A user
  # actor carries the participant id (the DB check constraint requires it).
  def ingest(type, seq:, actor_kind: 'system')
    actor = actor_kind == 'user' ? { 'kind' => 'user', 'id' => participant.id } : { 'kind' => actor_kind }
    Events::Ingest.call(
      'session_id' => session.id,
      'ai_run_id' => run.id,
      'seq' => seq,
      'type' => type,
      'actor' => actor,
      'payload' => {}
    )
  end

  it "transitions queued → running on the sidecar's run_started" do
    ingest('run_started', seq: 1, actor_kind: 'user')
    expect(run.reload.status).to(eq('running'))
  end

  it 'transitions running → failed on run_failed' do
    run.update!(status: 'running')
    ingest('run_failed', seq: 1)
    expect(run.reload.status).to(eq('failed'))
  end

  it 'transitions to awaiting_review on run_finished when a changeset is ready' do
    run.update!(status: 'running')
    create(:event, session: session, ai_run: run, seq: 50, event_type: 'changeset_ready', actor_kind: 'system')
    ingest('run_finished', seq: 1)
    expect(run.reload.status).to(eq('awaiting_review'))
  end

  it 'transitions to completed_clean on run_finished with no changeset' do
    run.update!(status: 'running')
    ingest('run_finished', seq: 1)
    expect(run.reload.status).to(eq('completed_clean'))
  end

  it 'run_interrupted → awaiting_review when the worktree is dirty' do
    run.update!(status: 'running')
    allow_any_instance_of(Git::WorktreeManager).to(receive(:dirty?).and_return(true))
    ingest('run_interrupted', seq: 1, actor_kind: 'user')
    expect(run.reload.status).to(eq('awaiting_review'))
  end

  it 'run_interrupted → completed_clean when the worktree is clean' do
    run.update!(status: 'running')
    allow_any_instance_of(Git::WorktreeManager).to(receive(:dirty?).and_return(false))
    ingest('run_interrupted', seq: 1, actor_kind: 'user')
    expect(run.reload.status).to(eq('completed_clean'))
  end

  describe 'chat-mode session (no changeset → never awaiting_review)' do
    let(:session) { create(:session, mode: 'chat') }

    it 'run_finished → completed_clean even when a changeset_ready event exists' do
      run.update!(status: 'running')
      create(:event, session: session, ai_run: run, seq: 50, event_type: 'changeset_ready', actor_kind: 'system')
      ingest('run_finished', seq: 1)
      expect(run.reload.status).to(eq('completed_clean'))
    end

    it 'run_interrupted → completed_clean (no worktree to inspect)' do
      run.update!(status: 'running')
      ingest('run_interrupted', seq: 1, actor_kind: 'user')
      expect(run.reload.status).to(eq('completed_clean'))
    end
  end
end
