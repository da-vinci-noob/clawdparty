# frozen_string_literal: true

require 'open3'

module Git
  # Rails owns worktree creation (the frozen sidecar-protocol convention): the
  # per-session worktree lives at <repo>/.clawdparty/worktrees/session-<id> on
  # branch clawd/session-<id>, created against the bind-mounted target repo at
  # TARGET_REPO_PATH (default /repo, identical in the sidecar container). The
  # sidecar only uses it as `cwd`; it never creates or relocates it.
  class WorktreeManager
    class GitError < StandardError; end

    def self.repo_root
      ENV.fetch('TARGET_REPO_PATH', '/repo')
    end

    def initialize(session, repo_root: self.class.repo_root)
      @session = session
      @repo_root = repo_root
    end

    attr_reader :session, :repo_root

    def worktree_path
      File.join(repo_root, '.clawdparty', 'worktrees', "session-#{session.id}")
    end

    def branch_name
      "clawd/session-#{session.id}"
    end

    # Create the worktree (idempotent: reuse if it already exists) and return its path.
    def ensure_worktree!
      return worktree_path if worktree_exists?

      run_git!('worktree', 'add', '-b', branch_name, worktree_path, 'HEAD', dir: repo_root)
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
