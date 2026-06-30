# frozen_string_literal: true

# Client-facing run control (routed under the /api scope). Each action is
# SessionPolicy-gated (run/interrupt/follow-up = owner+editor); status derives
# from events, never a bespoke cable message. Start is async: respond after the
# sidecar accepts, do not block on completion.
class RunsController < ApplicationController
  before_action :require_user

  rescue_from Runs::Start::ActiveRunExists, Sidecar::Client::ActiveRunConflict do
    render(json: { errors: [{ message: 'A run is already active for this session' }] }, status: :conflict)
  end
  rescue_from Runs::Start::DirtyWorktree do
    render(json: { errors: [{ message: 'Worktree is dirty; cannot start a fresh run' }] },
           status: :unprocessable_content)
  end
  rescue_from Sidecar::Client::UnknownRun do
    render_not_found
  end

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
      mode: params[:mode].presence || 'fresh'
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
    Sidecar::Client.new.interrupt(run.id, requested_by: participant.id.to_s)
    render(json: { run_id: run.id.to_s, accepted: true }, status: :ok)
  end

  private

  def find_run!
    AiRun.find_by(id: params[:id]) || raise(ActiveRecord::RecordNotFound)
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
