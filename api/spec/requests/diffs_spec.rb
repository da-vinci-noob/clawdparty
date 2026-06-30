# frozen_string_literal: true

require 'rails_helper'
require 'open3'
require 'tmpdir'
require 'fileutils'

RSpec.describe('Run diff API') do
  let(:session) { create(:session) }
  let(:run) { create(:ai_run, session: session, status: 'awaiting_review') }

  def git!(dir, *args)
    out, err, st = Open3.capture3('git', '-C', dir, *args)
    raise("git #{args.join(' ')} failed: #{err}#{out}") unless st.success?
  end

  # Real throwaway repo + worktree at TARGET_REPO_PATH so Git::Diff runs real git.
  around do |example|
    Dir.mktmpdir('clawd-diff') do |dir|
      git!(dir, 'init', '-b', 'main')
      git!(dir, 'config', 'user.email', 'a@b.c')
      git!(dir, 'config', 'user.name', 'x')
      File.write(File.join(dir, 'README.md'), "base\n")
      git!(dir, 'add', '-A')
      git!(dir, 'commit', '-m', 'init')
      @repo = dir
      example.run
    end
  end

  before do
    allow(Git::WorktreeManager).to(receive(:repo_root).and_return(@repo))
    @wt = Git::WorktreeManager.new(session).ensure_worktree!
  end

  describe 'GET /api/runs/:id/diff' do
    it 'counts a freshly-created UNTRACKED file (intent-to-add) for a viewer (200)' do
      File.write(File.join(@wt, 'new_file.rb'), "puts 'claude wrote this'\n")
      join_as(session, role: 'viewer')

      get("/api/runs/#{run.id}/diff")
      expect(response).to(have_http_status(:ok))
      body = response.parsed_body
      paths = body['files'].pluck('path')
      expect(paths).to(include('new_file.rb'))
      expect(body['patch']).to(include('new_file.rb'))
      expect(body['patch']).to(include('claude wrote this'))
    end

    it 'reflects a modification to a tracked file' do
      File.write(File.join(@wt, 'README.md'), "base\nmore\n")
      join_as(session, role: 'reviewer')

      get("/api/runs/#{run.id}/diff")
      expect(response).to(have_http_status(:ok))
      stat = response.parsed_body['files'].find { |f| f['path'] == 'README.md' }
      expect(stat['insertions']).to(eq(1))
    end

    it 'does not corrupt worktree content: repeated diffs are consistent' do
      File.write(File.join(@wt, 'new_file.rb'), "x\n")
      join_as(session, role: 'viewer')

      get("/api/runs/#{run.id}/diff")
      first = response.parsed_body['patch']
      get("/api/runs/#{run.id}/diff")
      expect(response.parsed_body['patch']).to(eq(first))
      expect(File.read(File.join(@wt, 'new_file.rb'))).to(eq("x\n"))
    end

    it 'refuses a non-participant with 404 (not 403)' do
      other_session = create(:session)
      other_run = create(:ai_run, session: other_session, status: 'awaiting_review')
      join_as(session, role: 'owner') # participant of `session`, not `other_session`
      get("/api/runs/#{other_run.id}/diff")
      expect(response).to(have_http_status(:not_found))
    end
  end
end
