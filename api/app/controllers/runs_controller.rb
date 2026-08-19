# frozen_string_literal: true

# Client-facing run control (routed under the /api scope). Each action is
# SessionPolicy-gated (run/interrupt/follow-up = owner+editor; approve/reject =
# owner+editor+reviewer); status derives from events, never a bespoke cable
# message. Start is async: respond after the harness accepts, do not block on
# completion.
class RunsController < ApplicationController
  include RunCapabilities
  include RunErrorResponses
  include ProviderErrorResponses

  before_action :require_user

  # POST /api/sessions/:session_id/runs
  def create
    session = Session.find_by(id: params[:session_id])
    raise(ActiveRecord::RecordNotFound) if session.nil?

    participant = authorize_action!(:run, session)
    # BEFORE model resolution, which reaches a provider over the network. A malformed lane is a
    # client error knowable from the request alone, and resolving a model first meant an invalid
    # lane surfaced as a provider failure — the wrong error, after a round trip nobody needed.
    #
    # An archived session is the same case and was making the same mistake: a closed session on a
    # host whose default provider serves nothing was refused with "lists no models" instead of
    # "archived". It goes FIRST because a closed session makes the rest of the request moot.
    # `Runs::Start` keeps its own check as the invariant for every other caller.
    raise(Runs::Start::SessionArchived) if session.archived?

    validate_lane!
    result = start_run!(session, participant)
    render(json: { id: result.ai_run.id.to_s, status: result.ai_run.status }, status: :accepted)
  end

  # POST /api/runs/:id/messages
  def messages
    run = find_run!
    participant = authorize_action!(:run, run.session)
    Harness::Client.new.send_message(run.id, message: params.require(:message), requested_by: participant.id.to_s)
    render(json: { run_id: run.id.to_s, accepted: true }, status: :ok)
  end

  # POST /api/runs/:id/interrupt
  def interrupt
    run = find_run!
    participant = authorize_action!(:interrupt, run.session)
    begin
      Harness::Client.new.interrupt(run.id, requested_by: participant.id.to_s)
    rescue Harness::Client::UnknownRun
      # The harness has no such active run (it restarted / the run already ended),
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
             lane: run.lane,
             base_sha: result.base_sha,
             files: result.files.map(&:to_h),
             patch: result.patch,
             # Always present (empty for a single-lane session) so a client does
             # not have to distinguish "no conflicts" from "this server does not report them".
             conflicts: result.conflicts.map(&:to_h)
           }, status: :ok)
  end

  # POST /api/runs/:id/approve — owner/editor/reviewer keeps the reviewed
  # changeset. The run becomes approved + a changeset_approved event; the worktree
  # is untouched.
  def approve
    run = find_run!
    participant = authorize_action!(:approve, run.session)
    result = Runs::Approve.call(run: run, reviewed_by: participant)
    render(json: { id: result.id.to_s, status: result.status }, status: :ok)
  end

  # POST /api/runs/:id/reject — owner/editor/reviewer discards the reviewed
  # changeset. The worktree is reverted, the run becomes rejected + a
  # changeset_rejected event.
  def reject
    run = find_run!
    participant = authorize_action!(:reject, run.session)
    result = Runs::Reject.call(run: run, reviewed_by: participant)
    render(json: { id: result.id.to_s, status: result.status }, status: :ok)
  end

  private

  # Validated run start: permission mode + capability selection (both gated
  # behind the :run authorization already resolved in #create) threaded into
  # Runs::Start. Kept out of #create to keep that action's ABC size honest.
  # Raises `InvalidLane`, which `RunErrorResponses` renders as a 422 naming the rule. Validated in
  # the controller as well as in `WorktreeManager` because a `chat` session never builds a worktree
  # — so the constructor's guard would never run, and the lane would still reach the harness and
  # the `ai_runs` row unchecked.
  def validate_lane!
    lane = params[:lane].presence
    return if lane.nil? || Git::WorktreeManager.valid_lane?(lane)

    raise(Git::WorktreeManager::InvalidLane, "invalid lane name: #{lane.inspect}")
  end

  def start_run!(session, participant)
    provider = effective_provider(session)
    Runs::Start.call(
      session: session,
      requested_by: participant,
      prompt: params.require(:prompt),
      model: effective_model(session, provider),
      mode: params[:mode].presence || 'fresh',
      provider: provider,
      lane: params[:lane].presence || Runs::Start::DEFAULT_LANE,
      effort: params[:effort].presence,
      **capability_params(session)
    )
  end

  # Precedence, and the ORDER is the whole point: the composer's explicit pick, then the session's
  # Settings default, then the built-in. Computing `ResolveModel` first — as this did — always
  # produced a model, so `Runs::Start`'s fallback to the session default could never be reached and
  # the setting was unreachable through the only path that matters.
  def effective_provider(session)
    params[:provider].presence || session.default_provider.presence || Runs::Start::DEFAULT_PROVIDER
  end

  # Resolved WITHIN the effective provider: a model id only means something relative to the provider
  # that serves it.
  def effective_model(session, provider)
    params[:model].presence || session.default_model.presence ||
      Runs::ResolveModel.call(provider: provider, requested: nil)
  end

  def find_run!
    AiRun.find_by(id: params[:id]) || raise(ActiveRecord::RecordNotFound)
  end

  # Harness-less finalize: ingest a synthetic run_interrupted so it persists, broadcasts (clients
  # drop it from active), and Runs::Finalize transitions it.
  #
  # NO seq, and the comment here used to say the opposite — "Rails owns the next seq since the
  # harness is no longer emitting for this run". That is the same assumption that made
  # `HealthcheckJob` silently destroy `recovery_applied`, and it is false for the same
  # reason: this path runs when the harness answers UnknownRun because it RESTARTED, and a
  # restarted harness runs boot recovery over this very run and emits from its own store. Shipping
  # is async and retried, so that POST can still be in flight when the interrupt lands. Rails would
  # take the seq recovery already used, and `Events::Ingest` reports the loser as `skipped`.
  #
  # `seq` and `store_seq` are properties of the RECORD; Rails appended this itself, so it holds
  # neither. Unlike the `changeset_*` appends this one is genuinely exposed, because the run is
  # ACTIVE and the harness still holds a non-terminal position marker.
  def reconcile_interrupted(run, participant)
    return unless run.active?

    Events::Ingest.call(
      'session_id' => run.session_id,
      'ai_run_id' => run.id,
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
end
