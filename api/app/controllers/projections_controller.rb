# frozen_string_literal: true

# Repair and audit the event projection from the harness's record.
#
# NOT under `Internal::` despite the original suggestion of that directory. Those controllers authenticate
# a shared secret and carry no participant identity, so an "owner-gated" action cannot be
# expressed there at all — the gate needs a participant. Placed here and gated on
# `manage_session`, which is the owner-only capability every other session-management action
# already uses.
#
# `check` is safe and read-only; `rederive` MUTATES the projection, which is why it is
# owner-only rather than available to anyone who can approve a diff.
class ProjectionsController < ApplicationController
  before_action :require_user

  # GET /api/sessions/:session_id/projection/check
  def check
    session = find_session!
    authorize!(:manage_session, session)
    result = Events::ProjectionCheck.call(session: session)

    render(json: {
             diverged: result.diverged?,
             reason: result.reason,
             rails: { high_water: result.rails_high_water, count: result.rails_count },
             harness: { high_water: result.harness_high_water, count: result.harness_count }
           }, status: :ok)
  end

  # POST /api/sessions/:session_id/projection/rederive
  #
  # `reset` must be asked for EXPLICITLY. Gap-fill is additive and safe to run at any time;
  # reset deletes the session's rows and rebuilds them with new ids, so a connected client's
  # cursor stops meaning anything and it has to reload.
  def rederive
    session = find_session!
    authorize!(:manage_session, session)
    result = Events::Rederive.call(session: session, reset: reset?)

    render(json: {
             reset: reset?, from_store_seq: result.from_store_seq, high_water: result.high_water,
             accepted: result.accepted, skipped: result.skipped, rejected: result.rejected
           }, status: :ok)
  end

  private

  def find_session!
    Session.find_by(id: params[:session_id]) or raise(ActiveRecord::RecordNotFound)
  end

  def reset?
    ActiveModel::Type::Boolean.new.cast(params[:reset]).present?
  end
end
