# frozen_string_literal: true

require 'open3'

module Git
  # Computes a run's diff in the session worktree. CRITICAL: `git add
  # --intent-to-add -A` is run FIRST so untracked files Claude created are counted
  # — without it a new file is invisible in `git diff HEAD`. `--intent-to-add`
  # stages only the path-intent, not content, so it does not mutate file content
  # (a reject's `git reset --hard && git clean -fd` clears the intent). The diff is
  # vs the worktree HEAD; the run records `base_sha` at start for reference. Served
  # over REST only (frozen http-api-contract: diffs never ride the cable).
  class Diff
    class GitError < StandardError; end

    Result = Struct.new(:base_sha, :files, :patch, keyword_init: true)
    FileStat = Struct.new(:path, :insertions, :deletions, :binary, keyword_init: true)

    def initialize(run, worktree: nil)
      @run = run
      @worktree = worktree || Git::WorktreeManager.new(run.session)
    end

    def call
      mark_untracked! # intent-to-add so new files are counted
      Result.new(base_sha: @run.base_sha, files: numstat, patch: patch)
    end

    private

    def mark_untracked!
      run_git!('add', '--intent-to-add', '-A')
    end

    # `git diff HEAD --numstat`: one row per changed file. A binary file shows
    # "-\t-\t<path>"; we surface insertions/deletions as nil + binary: true.
    def numstat
      run_git!('diff', 'HEAD', '--numstat').each_line.filter_map do |line|
        added, deleted, path = line.strip.split("\t", 3)
        next if path.blank?

        binary = added == '-' && deleted == '-'
        FileStat.new(
          path: path,
          insertions: binary ? nil : added.to_i,
          deletions: binary ? nil : deleted.to_i,
          binary: binary
        )
      end
    end

    def patch
      run_git!('diff', 'HEAD')
    end

    def run_git!(*args)
      stdout, stderr, status = Open3.capture3('git', '-C', @worktree.worktree_path, *args)
      raise(GitError, "git #{args.join(' ')} failed: #{stderr.strip}") unless status.success?

      stdout
    end
  end
end
