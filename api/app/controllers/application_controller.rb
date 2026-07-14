# frozen_string_literal: true

class ApplicationController < ActionController::API
  # api_only omits cookie support from ActionController::API; include it so the
  # signed httpOnly `clawd_uid` cookie can be set and read.
  include ActionController::Cookies

  COOKIE_NAME = :clawd_uid

  rescue_from ActiveRecord::RecordInvalid, with: :render_unprocessable
  rescue_from ActiveRecord::RecordNotFound, with: :render_not_found
  rescue_from SessionPolicy::NotAuthorized, with: :render_forbidden

  private

  def current_user
    return @current_user if defined?(@current_user)

    uid = cookies.signed[COOKIE_NAME]
    @current_user = uid && User.find_by(id: uid)
  end

  def require_user
    render_not_found and return unless current_user
  end

  # Re-derive participantship/role for the TARGET session from the participants
  # table — the cookie carries only a user id, never a session scope or role.
  def participant_for(session)
    return nil unless current_user

    session.participants.find_by(user_id: current_user.id)
  end

  # Cross-session / unknown resource => 404 (anti-enumeration), never 403.
  def authorize!(action, session)
    participant = participant_for(session)
    raise(ActiveRecord::RecordNotFound) if participant.nil?

    SessionPolicy.new(participant: participant, session: session).authorize!(action)
  end

  def render_unprocessable(error)
    render(json: { errors: Array(error.record&.errors&.full_messages || error.message).map { |m| { message: m } } },
           status: :unprocessable_content)
  end

  def render_not_found(_error = nil)
    render(json: { errors: [{ message: 'Not found' }] }, status: :not_found)
  end

  def render_forbidden(_error = nil)
    render(json: { errors: [{ message: 'Forbidden' }] }, status: :forbidden)
  end
end
