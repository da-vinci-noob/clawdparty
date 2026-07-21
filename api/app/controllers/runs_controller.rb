# frozen_string_literal: true

# Client-facing run control (routed under the /api scope). Each action is
# SessionPolicy-gated (run/interrupt/follow-up = owner+editor); status derives
# from events, never a bespoke cable message. Start is async: respond after the
# sidecar accepts, do not block on completion.
class RunsController < ApplicationController
  include RunPermissionModes
  include RunErrorResponses

  before_action :require_user

  # POST /api/sessions/:session_id/runs
  def create
    session = Session.find_by(id: params[:session_id])
    raise(ActiveRecord::RecordNotFound) if session.nil?

    participant = authorize_action!(:run, session)
    result = Runs::Start.call(
      session: session,
      requested_by: participant,
      prompt: params.require(:prompt),
      model: params[:model].presence || default_model,
      mode: params[:mode].presence || 'fresh',
      permission_mode: permission_mode_param(session)
    )
    render(json: { id: result.ai_run.id.to_s, status: result.ai_run.status }, status: :accepted)
  end

  # POST /api/runs/:id/messages
  def messages
    run = find_run!
    participant = authorize_action!(:run, run.session)
    Sidecar::Client.new.send_message(run.id, message: params.require(:message), requested_by: participant.id.to_s)
    render(json: { run_id: run.id.to_s, accepted: true }, status: :ok)
  end

  # POST /api/runs/:id/interrupt
  def interrupt
    run = find_run!
    participant = authorize_action!(:interrupt, run.session)
    begin
      Sidecar::Client.new.interrupt(run.id, requested_by: participant.id.to_s)
    rescue Sidecar::Client::UnknownRun
      # The sidecar has no such active run (it restarted / the run already ended),
      # but Rails still shows it active. Reconcile: synthesize run_interrupted so
      # the run finalizes and the session unblocks — never a dead-end 404.
      reconcile_interrupted(run, participant)
    end
    render(json: { run_id: run.id.to_s, accepted: true }, status: :ok)
  end

  # GET /api/runs/:id/diff — the run's diff vs base_sha, REST only (never cable),
  # view-gated (all roles review). Untracked files are counted (intent-to-add).
  def diff
    run = find_run!
    authorize_action!(:view, run.session)
    result = Git::Diff.new(run).call
    render(json: {
             run_id: run.id.to_s,
             base_sha: result.base_sha,
             files: result.files.map(&:to_h),
             patch: result.patch
           }, status: :ok)
  end

  # POST /api/runs/:id/approve — owner keeps the reviewed changeset. The run
  # becomes approved + a changeset_approved event; the worktree is untouched.
  def approve
    run = find_run!
    participant = authorize_action!(:approve, run.session)
    result = Runs::Approve.call(run: run, reviewed_by: participant)
    render(json: { id: result.id.to_s, status: result.status }, status: :ok)
  end

  # POST /api/runs/:id/reject — owner discards the reviewed changeset. The
  # worktree is reverted, the run becomes rejected + a changeset_rejected event.
  def reject
    run = find_run!
    participant = authorize_action!(:reject, run.session)
    result = Runs::Reject.call(run: run, reviewed_by: participant)
    render(json: { id: result.id.to_s, status: result.status }, status: :ok)
  end

  private

  def find_run!
    AiRun.find_by(id: params[:id]) || raise(ActiveRecord::RecordNotFound)
  end

  # Sidecar-less finalize: ingest a synthetic run_interrupted (Rails owns the next
  # seq since the sidecar is no longer emitting for this run) so it persists,
  # broadcasts (clients drop it from active), and Runs::Finalize transitions it.
  def reconcile_interrupted(run, participant)
    return unless run.active?

    Events::Ingest.call(
      'session_id' => run.session_id,
      'ai_run_id' => run.id,
      'seq' => (run.events.maximum(:seq) || 0) + 1,
      'type' => 'run_interrupted',
      'actor' => { 'kind' => 'user', 'id' => participant.id },
      'payload' => {}
    )
  end

  # 404 for a non-participant/unknown session; 403 for a participant whose role
  # is not permitted (anti-enumeration, via ApplicationController#authorize!).
  def authorize_action!(action, session)
    participant = participant_for(session)
    raise(ActiveRecord::RecordNotFound) if participant.nil?

    authorize!(action, session)
    participant
  end

  def default_model
    ENV.fetch('ANTHROPIC_MODEL', 'claude-opus-4-8')
  end
end
