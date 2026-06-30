# frozen_string_literal: true

require 'rails_helper'
require 'open3'
require 'tmpdir'
require 'fileutils'

RSpec.describe(Git::Diff) do
  subject(:diff) { described_class.new(run, worktree: worktree) }

  let(:session) { create(:session) }
  let(:run) { create(:ai_run, session: session, base_sha: 'recorded-at-start') }
  let(:worktree) { Git::WorktreeManager.new(session, repo_root: @repo) }

  def git!(dir, *args)
    out, err, st = Open3.capture3('git', '-C', dir, *args)
    raise("git #{args.join(' ')} failed: #{err}#{out}") unless st.success?
  end

  around do |example|
    Dir.mktmpdir('clawd-diff-unit') do |dir|
      git!(dir, 'init', '-b', 'main')
      git!(dir, 'config', 'user.email', 'a@b.c')
      git!(dir, 'config', 'user.name', 'x')
      File.write(File.join(dir, 'README.md'), "base\n")
      git!(dir, 'add', '-A')
      git!(dir, 'commit', '-m', 'init')
      @repo = dir
      @wt = worktree.ensure_worktree!
      example.run
    end
  end

  it 'counts an untracked file via intent-to-add' do
    File.write(File.join(@wt, 'fresh.rb'), "a = 1\n")
    result = diff.call
    expect(result.files.map(&:path)).to(include('fresh.rb'))
    expect(result.patch).to(include('fresh.rb'))
  end

  it 'reports numstat insertions/deletions for a tracked change' do
    File.write(File.join(@wt, 'README.md'), "base\nb\nc\n")
    stat = diff.call.files.find { |f| f.path == 'README.md' }
    expect(stat.insertions).to(eq(2))
    expect(stat.deletions).to(eq(0))
    expect(stat.binary).to(be(false))
  end

  it 'marks a binary file as binary in numstat' do
    File.binwrite(File.join(@wt, 'blob.bin'), "\x00\x01\x02\x03")
    stat = diff.call.files.find { |f| f.path == 'blob.bin' }
    expect(stat.binary).to(be(true))
    expect(stat.insertions).to(be_nil)
  end

  it 'stages intent only — does not change file content (repeatable)' do
    File.write(File.join(@wt, 'fresh.rb'), "x\n")
    first = diff.call.patch
    expect(File.read(File.join(@wt, 'fresh.rb'))).to(eq("x\n"))
    expect(diff.call.patch).to(eq(first))
  end

  it 'returns the run-recorded base_sha' do
    expect(diff.call.base_sha).to(eq('recorded-at-start'))
  end
end
