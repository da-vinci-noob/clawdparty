# frozen_string_literal: true

# Read-only repo browsing (routed under the /api scope). The tree + content for a
# session's worktree, SessionPolicy-gated to `view` (all roles read). ALL content
# is served through RepoBrowser — the single safe chokepoint (containment +
# denylist + cap + binary). Refusals map to defined statuses the client renders
# as "not shown": traversal/denylist/not-found → 404, oversized → 413, binary →
# 415. A non-participant (or unknown session) gets 404, never 403 (anti-enumeration).
class FilesController < ApplicationController
  before_action :require_user

  rescue_from RepoBrowser::NotFound, with: :render_not_found
  rescue_from RepoBrowser::Oversized do
    render(json: { errors: [{ message: 'File too large to display' }] }, status: :content_too_large)
  end
  rescue_from RepoBrowser::Binary do
    render(json: { errors: [{ message: 'Binary file not displayed' }] }, status: :unsupported_media_type)
  end

  # GET /api/sessions/:session_id/files
  def index
    session = authorized_session!
    render(json: { files: RepoBrowser.new(session).tree }, status: :ok)
  end

  # GET /api/sessions/:session_id/files/content?path=…
  def content
    session = authorized_session!
    path = params.require(:path)
    body = RepoBrowser.new(session).content(path)
    render(json: { path: path, content: body }, status: :ok)
  end

  private

  # 404 for an unknown session or a non-participant (authorize! raises
  # RecordNotFound when not a participant); view is permitted for every role.
  def authorized_session!
    session = Session.find_by(id: params[:session_id])
    raise(ActiveRecord::RecordNotFound) if session.nil?

    authorize!(:view, session)
    session
  end
end
