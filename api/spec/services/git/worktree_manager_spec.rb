# frozen_string_literal: true

require 'rails_helper'
require 'open3'
require 'tmpdir'
require 'fileutils'

RSpec.describe(Git::WorktreeManager) do
  subject(:manager) { described_class.new(session, repo_root: @repo) }

  let(:session) { create(:session) }

  around do |example|
    Dir.mktmpdir('clawd-repo') do |dir|
      # A throwaway git repo with one commit, standing in for the bind-mounted /repo.
      def git!(dir, *args)
        out, err, st = Open3.capture3('git', '-C', dir, *args)
        raise("git #{args.join(' ')} failed: #{err}#{out}") unless st.success?
      end
      git!(dir, 'init', '-b', 'main')
      git!(dir, 'config', 'user.email', 'a@b.c')
      git!(dir, 'config', 'user.name', 'x')
      File.write(File.join(dir, 'README.md'), "seed\n")
      git!(dir, 'add', '-A')
      git!(dir, 'commit', '-m', 'init')
      @repo = dir
      example.run
    end
  end

  describe '.repo_root (the in-container path is always /repo, per the frozen convention)' do
    it 'does NOT read the host-side TARGET_REPO_PATH bind-mount source' do
      allow(ENV).to(receive(:fetch).and_call_original)
      # TARGET_REPO_PATH is the HOST mount source for /repo; reading it as the
      # in-container repo root points at a host path that does not exist in the
      # container (the picker/worktrees then 500). repo_root must stay /repo.
      allow(ENV).to(receive(:fetch).with('TARGET_REPO_PATH', anything).and_return('/Users/someone/Developer'))
      expect(described_class.repo_root).to(eq('/repo'))
    end
  end

  it 'creates the worktree at the frozen path + branch' do
    path = manager.ensure_worktree!
    expect(path).to(eq(File.join(@repo, '.clawdparty', 'worktrees', "session-#{session.id}")))
    expect(File.exist?(File.join(path, '.git'))).to(be(true))
    expect(File.read(File.join(path, 'README.md'))).to(eq("seed\n"))
  end

  it 'is idempotent (reuse on second call)' do
    first = manager.ensure_worktree!
    expect { manager.ensure_worktree! }.not_to(raise_error)
    expect(manager.ensure_worktree!).to(eq(first))
  end

  it 'records base_sha matching the repo HEAD' do
    manager.ensure_worktree!
    head = `git -C #{@repo} rev-parse HEAD`.strip
    expect(manager.base_sha).to(eq(head))
  end

  it 'detects a dirty worktree and reset_hard! restores it clean' do
    path = manager.ensure_worktree!
    expect(manager.dirty?).to(be(false))
    File.write(File.join(path, 'new_file.txt'), "claude wrote this\n")
    expect(manager.dirty?).to(be(true))
    manager.reset_hard!
    expect(manager.dirty?).to(be(false))
    expect(File.exist?(File.join(path, 'new_file.txt'))).to(be(false))
  end

  it 'commit! commits the dirty worktree, returns a clean tree, and preserves the change' do
    path = manager.ensure_worktree!
    File.write(File.join(path, 'approved.rb'), "kept = true\n")
    expect(manager.dirty?).to(be(true))

    sha = manager.commit!('approve changeset')
    expect(manager.dirty?).to(be(false))
    expect(sha).to(match(/\A[0-9a-f]{7,40}\z/))
    show, _e, _s = Open3.capture3('git', '-C', path, 'show', '--stat', 'HEAD')
    expect(show).to(include('approved.rb'))
  end

  it 'commit! is a no-op on a clean worktree (returns HEAD)' do
    manager.ensure_worktree!
    expect { manager.commit!('nothing') }.not_to(raise_error)
    expect(manager.dirty?).to(be(false))
  end

  describe 'per-repo worktree (roots at the session repository_path)' do
    # Mirror production: a NON-git parent mount holding git subdir repos. The
    # worktree must be created FROM the selected repo, with its working files
    # centralized under the (non-git) mount root.
    around do |example|
      Dir.mktmpdir('clawd-mount') do |mount|
        proj = File.join(mount, 'proj')
        FileUtils.mkdir_p(proj)
        git!(proj, 'init', '-b', 'main')
        git!(proj, 'config', 'user.email', 'a@b.c')
        git!(proj, 'config', 'user.name', 'x')
        File.write(File.join(proj, 'README.md'), "proj-seed\n")
        git!(proj, 'add', '-A')
        git!(proj, 'commit', '-m', 'init')
        @mount = mount
        @proj = proj
        example.run
      end
    end

    it 'creates the worktree from the selected repo, centralized under the mount root' do
      session.update!(repository_path: @proj)
      mgr = described_class.new(session, repo_root: @mount)
      path = mgr.ensure_worktree!

      expect(path).to(eq(File.join(@mount, '.clawdparty', 'worktrees', "session-#{session.id}")))
      expect(File.exist?(File.join(path, '.git'))).to(be(true))
      # Content comes from the SELECTED repo (proj), not the non-git mount root.
      expect(File.read(File.join(path, 'README.md'))).to(eq("proj-seed\n"))
    end

    it 'falls back to the mount root when repository_path is blank' do
      # Blank repository_path + non-git mount → the git base is the mount root,
      # which is not a repo here, so it raises (matches single-repo-mount reality).
      mgr = described_class.new(session, repo_root: @mount)
      expect { mgr.ensure_worktree! }.to(raise_error(described_class::GitError))
    end

    it 'raises GitError when the selected repository_path is not a git repo' do
      plain = File.join(@mount, 'plain')
      FileUtils.mkdir_p(plain)
      session.update!(repository_path: plain)
      mgr = described_class.new(session, repo_root: @mount)
      expect { mgr.ensure_worktree! }.to(raise_error(described_class::GitError))
    end
  end
end
