# frozen_string_literal: true

# Maps the run lifecycle's service/sidecar errors to their client HTTP responses.
# Kept in a concern so RunsController stays focused on the run actions themselves;
# each raise site lives in Runs::* / Sidecar::Client and lands here as one status.
module RunErrorResponses
  extend ActiveSupport::Concern

  included do
    rescue_from Runs::Start::ActiveRunExists, Sidecar::Client::ActiveRunConflict do
      render_error('A run is already active for this session', :conflict)
    end
    rescue_from Runs::Start::DirtyWorktree do
      render_error('Worktree is dirty; cannot start a fresh run', :unprocessable_content)
    end
    rescue_from Runs::Start::SessionArchived do
      render_error('Session is archived; cannot start a run', :conflict)
    end
    rescue_from Sidecar::Client::UnknownRun do
      render_not_found
    end
    rescue_from Runs::Approve::NotReviewable, Runs::Reject::NotReviewable do
      render_error('Run is not awaiting review', :conflict)
    end
    rescue_from Sidecar::Client::TransportError do
      render_error('The Claude sidecar is unavailable; try again', :bad_gateway)
    end
    rescue_from Git::WorktreeManager::GitError do
      render_error('Could not prepare the session worktree — is the target repo a git repository? ' \
                   '(set TARGET_REPO_PATH to a repo with a commit)', :unprocessable_content)
    end
  end

  private

  def render_error(message, status)
    render(json: { errors: [{ message: message }] }, status: status)
  end
end
