# frozen_string_literal: true

# Resolves and validates a session's working directory for #create / #update.
# The directory is realpath-contained within the mounted repo root (defeating
# `../` + symlink escape); review mode additionally requires a git repository.
# Kept in a concern so SessionsController stays focused on the session actions.
module SessionWorkingDirectory
  extend ActiveSupport::Concern

  class DirectoryEscape < StandardError; end
  class RequiresGitRepo < StandardError; end

  included do
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
  end

  private

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
end
