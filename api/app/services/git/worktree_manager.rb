# frozen_string_literal: true

require 'open3'

module Git
  # Rails owns worktree creation (the frozen sidecar-protocol convention): the
  # per-session worktree lives at <repo>/.clawdparty/worktrees/session-<id> on
  # branch clawd/session-<id>, created against the bind-mounted target repo. The
  # sidecar only uses it as `cwd`; it never creates or relocates it.
  class WorktreeManager
    class GitError < StandardError; end

    # The IN-CONTAINER repo root — always /repo (the frozen convention: the host
    # dir is bind-mounted to /repo). This is deliberately NOT `TARGET_REPO_PATH`:
    # that env var is the HOST mount SOURCE (used only for compose substitution)
    # and would be a path that does not exist inside the container. `REPO_ROOT`
    # is an in-container override knob, defaulting to /repo.
    def self.repo_root
      ENV.fetch('REPO_ROOT', '/repo')
    end

    def initialize(session, repo_root: self.class.repo_root)
      @session = session
      @repo_root = repo_root
    end

    attr_reader :session, :repo_root

    # The git repository the worktree is created FROM: the session's SELECTED
    # repo (repository_path) when set, else the mount root. This is distinct from
    # repo_root, which is only where the worktree working files are centralized
    # (under the mount root, so the user's real repos are not littered with
    # worktree checkouts — only a branch ref + registration land in the repo).
    def repo_dir
      session.repository_path.presence || repo_root
    end

    def worktree_path
      File.join(repo_root, '.clawdparty', 'worktrees', "session-#{session.id}")
    end

    def branch_name
      "clawd/session-#{session.id}"
    end

    # Create the worktree (idempotent: reuse if it already exists) and return its
    # path. Created FROM repo_dir (the selected repo) so review runs operate on
    # the picked repository, not the mount root.
    def ensure_worktree!
      return worktree_path if worktree_exists?

      run_git!('worktree', 'add', '-b', branch_name, worktree_path, 'HEAD', dir: repo_dir)
      worktree_path
    end

    # The worktree HEAD sha at this moment — recorded as the run's base_sha.
    def base_sha
      run_git!('rev-parse', 'HEAD', dir: worktree_path).strip
    end

    # Is the worktree dirty (uncommitted changes, incl. untracked)?
    def dirty?
      status = run_git!('status', '--porcelain', dir: worktree_path)
      !status.strip.empty?
    end

    # Reject path: discard all changes in the worktree (used by the W3 changeset
    # service on reject). Provided here; this change does not call it on a flow.
    def reset_hard!
      run_git!('reset', '--hard', 'HEAD', dir: worktree_path)
      run_git!('clean', '-fd', dir: worktree_path)
      worktree_path
    end

    def worktree_exists?
      File.directory?(File.join(worktree_path, '.git')) || File.exist?(File.join(worktree_path, '.git'))
    end

    private

    def run_git!(*args, dir:)
      stdout, stderr, status = Open3.capture3('git', '-C', dir, *args)
      raise(GitError, "git #{args.join(' ')} failed: #{stderr.strip}") unless status.success?

      stdout
    end
  end
end
