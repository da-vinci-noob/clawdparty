# frozen_string_literal: true

# Create a session — the bootstrap entry point. Like joining (participants#create),
# this is unauthenticated: the trusted LAN is the perimeter and there is no prior
# identity before the first session exists. The creator supplies a display name +
# a title (+ optional mode / working directory), becomes the session's `owner`
# participant (and host), and receives the signed httpOnly `clawd_uid` cookie. The
# response mirrors the join shape so the web flow (store the participant → route
# into the session) is identical.
class SessionsController < ApplicationController
  class DirectoryEscape < StandardError; end

  # Only #update requires an identity; #create is the unauthenticated bootstrap.
  before_action :require_user, only: :update

  rescue_from DirectoryEscape do
    render(json: { errors: [{ message: 'Working directory must be inside the repo root' }] },
           status: :unprocessable_content)
  end

  def create
    title = params[:title].to_s.strip
    name = params[:name].to_s.strip
    return render_blank('Title') if title.empty?
    return render_blank('Name') if name.empty?
    return render_bad_mode unless Session::MODES.include?(mode_param)

    render_created(create_session_as_owner!(title: title, name: name))
  end

  # PATCH /api/sessions/:id — change the working directory (owner only). The new
  # directory is realpath-contained within the repo root and applies to the
  # session's SUBSEQUENT runs (it does not touch an in-flight run). A
  # non-participant/unknown session is 404 (anti-enumeration); a non-owner is 403.
  def update
    session = Session.find_by(id: params[:id])
    raise(ActiveRecord::RecordNotFound) if session.nil?

    authorize!(:manage_session, session)
    session.update!(repository_path: contained_repository_path)
    render(json: session_json(session), status: :ok)
  end

  private

  def render_created(participant)
    announce_participant_joined(participant)
    cookies.signed[COOKIE_NAME] = cookie_options(participant.user_id)
    render(json: participant_json(participant), status: :created)
  end

  def mode_param
    params[:mode].presence || 'review'
  end

  def create_session_as_owner!(title:, name:)
    ActiveRecord::Base.transaction do
      user = User.find_or_create_by!(name: name)
      session = Session.create!(
        title: title, host: user, mode: mode_param, repository_path: working_directory
      )
      Participant.create!(session: session, user: user, role: 'owner')
    end
  end

  # For a chat session, resolve the working directory (default: the repo root) and
  # confirm it is realpath-contained within the mounted repo root (defeat `../` +
  # symlink escape). Review sessions keep the raw value (the worktree is derived
  # from the session id, not this path).
  def working_directory
    given = params[:repository_path].presence
    return given unless mode_param == 'chat'
    return File.realpath(Git::WorktreeManager.repo_root) if given.nil?

    contain_in_repo!(given)
  end

  # The contained working directory for #update (default: the repo root when
  # blank). Always containment-checked, for both modes.
  def contained_repository_path
    given = params[:repository_path].presence
    return File.realpath(Git::WorktreeManager.repo_root) if given.nil?

    contain_in_repo!(given)
  end

  # Shared realpath-containment against the repo root; a refusal is a 422.
  def contain_in_repo!(path)
    RepoPaths.contain!(Git::WorktreeManager.repo_root, path)
  rescue RepoPaths::Escape
    raise(DirectoryEscape)
  end

  def session_json(session)
    { id: session.id.to_s, mode: session.mode, repository_path: session.repository_path }
  end

  def cookie_options(user_id)
    # No Secure flag — the LAN is plain HTTP (documented accepted MVP risk).
    { value: user_id, httponly: true, same_site: :lax }
  end

  def participant_json(participant)
    {
      id: participant.id.to_s,
      session_id: participant.session_id.to_s,
      role: participant.role,
      name: participant.user.name
    }
  end

  def render_blank(field)
    render(json: { errors: [{ message: "#{field} can't be blank" }] }, status: :unprocessable_content)
  end

  def render_bad_mode
    render(json: { errors: [{ message: "Mode must be one of #{Session::MODES.join(', ')}" }] },
           status: :unprocessable_content)
  end
end
