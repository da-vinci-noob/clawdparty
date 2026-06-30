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
end
