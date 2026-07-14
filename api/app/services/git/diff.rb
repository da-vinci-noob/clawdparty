# frozen_string_literal: true

require 'open3'
require 'tmpdir'

module Git
  # Computes a run's diff in the session worktree. Untracked files Claude created
  # must be counted (without `--intent-to-add` a new file is invisible to `git
  # diff HEAD`), but marking intent-to-add MUST NOT touch the worktree's real
  # index: that write takes `index.lock`, so concurrent diff requests (or a
  # crashed op leaving a stale lock) would 500 every diff. So the whole diff is
  # computed against a THROWAWAY index (seeded from HEAD, then untracked files
  # marked intent-to-add) via GIT_INDEX_FILE — the real index is never read,
  # written, or locked. The diff is vs the worktree HEAD; the run records
  # `base_sha` at start for reference. REST only (diffs never ride the cable).
  class Diff
    class GitError < StandardError; end

    Result = Struct.new(:base_sha, :files, :patch, keyword_init: true)
    FileStat = Struct.new(:path, :insertions, :deletions, :binary, keyword_init: true)

    def initialize(run, worktree: nil)
      @run = run
      @worktree = worktree || Git::WorktreeManager.new(run.session)
    end

    def call
      with_temp_index do |index_file|
        Result.new(base_sha: @run.base_sha, files: numstat(index_file), patch: patch(index_file))
      end
    end

    private

    # A temp index seeded from HEAD (so tracked files diff normally) with untracked
    # files marked intent-to-add — nothing here touches the worktree's real index
    # or its index.lock, so concurrent/repeated diffs never contend and a stale
    # real index.lock can't break the diff.
    def with_temp_index
      Dir.mktmpdir('clawd-diff') do |dir|
        index_file = File.join(dir, 'index')
        run_git!('read-tree', 'HEAD', index_file: index_file)
        run_git!('add', '--intent-to-add', '-A', index_file: index_file)
        yield(index_file)
      end
    end

    # `git diff HEAD --numstat`: one row per changed file. A binary file shows
    # "-\t-\t<path>"; we surface insertions/deletions as nil + binary: true.
    def numstat(index_file)
      run_git!('diff', 'HEAD', '--numstat', index_file: index_file).each_line.filter_map do |line|
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

    def patch(index_file)
      run_git!('diff', 'HEAD', index_file: index_file)
    end

    def run_git!(*args, index_file: nil)
      env = index_file ? { 'GIT_INDEX_FILE' => index_file } : {}
      stdout, stderr, status = Open3.capture3(env, 'git', '-C', @worktree.worktree_path, *args)
      raise(GitError, "git #{args.join(' ')} failed: #{stderr.strip}") unless status.success?

      stdout
    end
  end
end
