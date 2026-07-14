# frozen_string_literal: true

require 'rails_helper'

RSpec.describe(Runs::Finalize) do
  let(:session) { create(:session) }
  let(:run) { create(:ai_run, session: session, status: 'queued') }

  let(:participant) { create(:participant, session: session, role: 'owner') }

  # Ingest a run-lifecycle event for `run` (the sidecar-emitted path). A user
  # actor carries the participant id (the DB check constraint requires it).
  def ingest(type, seq:, actor_kind: 'system', payload: {})
    actor = actor_kind == 'user' ? { 'kind' => 'user', 'id' => participant.id } : { 'kind' => actor_kind }
    Events::Ingest.call(
      'session_id' => session.id,
      'ai_run_id' => run.id,
      'seq' => seq,
      'type' => type,
      'actor' => actor,
      'payload' => payload
    )
  end

  def changeset_ready_count
    run.events.where(event_type: 'changeset_ready').count
  end

  it "transitions queued → running on the sidecar's run_started" do
    ingest('run_started', seq: 1, actor_kind: 'user')
    expect(run.reload.status).to(eq('running'))
  end

  it 'captures claude_session_id from the run_started payload (so follow-ups can resume it)' do
    ingest('run_started', seq: 1, actor_kind: 'user', payload: { 'claude_session_id' => 'sess-abc' })
    expect(run.reload.claude_session_id).to(eq('sess-abc'))
    expect(run.status).to(eq('running'))
  end

  it 'leaves claude_session_id nil when run_started carries none' do
    ingest('run_started', seq: 1, actor_kind: 'user')
    expect(run.reload.claude_session_id).to(be_nil)
  end

  it 'transitions running → failed on run_failed' do
    run.update!(status: 'running')
    ingest('run_failed', seq: 1)
    expect(run.reload.status).to(eq('failed'))
  end

  it 'run_finished → awaiting_review + appends changeset_ready when the worktree is dirty' do
    run.update!(status: 'running')
    allow_any_instance_of(Git::WorktreeManager).to(receive(:dirty?).and_return(true))
    ingest('run_finished', seq: 1)
    expect(run.reload.status).to(eq('awaiting_review'))
    expect(changeset_ready_count).to(eq(1))
  end

  it 'run_finished → completed_clean + no changeset_ready when the worktree is clean' do
    run.update!(status: 'running')
    allow_any_instance_of(Git::WorktreeManager).to(receive(:dirty?).and_return(false))
    ingest('run_finished', seq: 1)
    expect(run.reload.status).to(eq('completed_clean'))
    expect(changeset_ready_count).to(eq(0))
  end

  it 'run_interrupted → awaiting_review + appends changeset_ready when the worktree is dirty' do
    run.update!(status: 'running')
    allow_any_instance_of(Git::WorktreeManager).to(receive(:dirty?).and_return(true))
    ingest('run_interrupted', seq: 1, actor_kind: 'user')
    expect(run.reload.status).to(eq('awaiting_review'))
    expect(changeset_ready_count).to(eq(1))
  end

  it 'run_interrupted → completed_clean when the worktree is clean' do
    run.update!(status: 'running')
    allow_any_instance_of(Git::WorktreeManager).to(receive(:dirty?).and_return(false))
    ingest('run_interrupted', seq: 1, actor_kind: 'user')
    expect(run.reload.status).to(eq('completed_clean'))
    expect(changeset_ready_count).to(eq(0))
  end

  it 'appends changeset_ready only once when a run is already awaiting_review' do
    run.update!(status: 'awaiting_review')
    create(:event, session: session, ai_run: run, seq: 5, event_type: 'changeset_ready', actor_kind: 'system')
    allow_any_instance_of(Git::WorktreeManager).to(receive(:dirty?).and_return(true))
    ingest('run_finished', seq: 10)
    expect(run.reload.status).to(eq('awaiting_review'))
    expect(changeset_ready_count).to(eq(1))
  end

  describe 'chat-mode session (no changeset → never awaiting_review)' do
    let(:session) { create(:session, mode: 'chat') }

    it 'run_finished → completed_clean with no changeset_ready (dirtiness is not consulted)' do
      run.update!(status: 'running')
      ingest('run_finished', seq: 1)
      expect(run.reload.status).to(eq('completed_clean'))
      expect(changeset_ready_count).to(eq(0))
    end

    it 'run_interrupted → completed_clean (no worktree to inspect)' do
      run.update!(status: 'running')
      ingest('run_interrupted', seq: 1, actor_kind: 'user')
      expect(run.reload.status).to(eq('completed_clean'))
      expect(changeset_ready_count).to(eq(0))
    end
  end
end
