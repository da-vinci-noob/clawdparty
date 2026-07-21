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
  class RequiresGitRepo < StandardError; end

  # #create is the unauthenticated bootstrap; every other action requires an identity.
  before_action :require_user, only: %i[index update archive]

  rescue_from DirectoryEscape do
    render(json: { errors: [{ message: 'Working directory must be inside the repo root' }] },
           status: :unprocessable_content)
  end

  rescue_from RequiresGitRepo do
    render(
      json: {
        errors: [
          { message: 'Review mode needs a git repository — pick a repo folder from the browser ' \
                     '(a directory containing .git).' }
        ]
      },
      status: :unprocessable_content
    )
  end

  # GET /api/sessions — the caller's session history: every session they host OR
  # participate in, de-duplicated, newest activity first. A per-user index (not
  # scoped to one session), so it is gated only by a valid clawd_uid; an
  # unauthenticated request is 404 via require_user (anti-enumeration). Each row
  # carries the caller's role (owner when host without a participant row).
  def index
    sessions = Session.for_user(current_user).includes(:participants)
    render(json: sessions.map { |session| history_row(session) }, status: :ok)
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
    session.update!(repository_path: working_directory_for(session.mode))
    render(json: session_json(session), status: :ok)
  end

  # POST /api/sessions/:id/archive — owner hard-closes the session (active →
  # archived, terminal). Idempotent: archiving an already-archived session is a
  # 200 no-op. Non-participant/unknown => 404 (anti-enumeration); non-owner => 403
  # (both via authorize!). A run cannot be started on an archived session — that
  # guard lives in Runs::Start.
  def archive
    session = Session.find_by(id: params[:id])
    raise(ActiveRecord::RecordNotFound) if session.nil?

    authorize!(:archive, session)
    session.update!(status: 'archived') unless session.archived?
    render(json: { id: session.id.to_s, status: session.status }, status: :ok)
  end

  private

  # One row of the per-user history list. `status` is server-derived (active /
  # archived); the web layer maps archived → the "revoked" badge. `owned` (am I the
  # host) lets the UI split "Your sessions" from "Joined".
  def history_row(session)
    {
      id: session.id.to_s,
      title: session.title,
      mode: session.mode,
      status: session.status,
      my_role: my_role(session),
      owned: session.host_id == current_user.id,
      last_activity_at: session.last_activity_at&.iso8601,
      created_at: session.created_at.iso8601
    }
  end

  # The caller's role in a session: their participant row's role, or `owner` when
  # they are the host without a participant row (belt-and-suspenders — creators
  # are made owner participants, but a host row alone still reads as owner).
  def my_role(session)
    participant = session.participants.find { |p| p.user_id == current_user.id }
    return participant.role if participant

    session.host_id == current_user.id ? 'owner' : nil
  end

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
        title: title, host: user, mode: mode_param, repository_path: working_directory_for(mode_param)
      )
      Participant.create!(session: session, user: user, role: 'owner')
    end
  end

  # The working directory to persist, for BOTH modes: an absolute path
  # realpath-contained within the mounted repo root (defeat `../` + symlink
  # escape), defaulting to the repo root when blank. review roots its worktree at
  # this repo; chat pins it as the run cwd. Used by both #create and #update.
  def working_directory
    given = params[:repository_path].presence
    return File.realpath(Git::WorktreeManager.repo_root) if given.nil?

    contain_in_repo!(given)
  end

  # The working directory to persist for the given mode. review needs a git
  # worktree base, so its resolved directory MUST be a git repository; a blank
  # dir defaults to the repo root (the non-git PARENT of the repos), which fails
  # here rather than later at run start. chat is unrestricted. The git check runs
  # AFTER containment, so an escaping path is still the existing escape 422.
  def working_directory_for(mode)
    dir = working_directory
    raise(RequiresGitRepo) if mode == 'review' && !git_repo?(dir)

    dir
  end

  def git_repo?(dir)
    File.exist?(File.join(dir, '.git'))
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
