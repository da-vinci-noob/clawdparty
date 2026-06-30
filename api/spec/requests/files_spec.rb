# frozen_string_literal: true

require 'rails_helper'
require 'open3'
require 'tmpdir'
require 'fileutils'

RSpec.describe('File API') do
  let(:session) { create(:session) }

  def git!(dir, *args)
    out, err, st = Open3.capture3('git', '-C', dir, *args)
    raise("git #{args.join(' ')} failed: #{err}#{out}") unless st.success?
  end

  # A real throwaway repo + worktree at TARGET_REPO_PATH, so RepoBrowser reads
  # actual files (the file API has no seam to stub — it IS the file reader). The
  # tmpdir lifecycle is `around`; the rspec-mocks stub must be in `before` (mocks
  # are not supported inside `around`).
  around do |example|
    Dir.mktmpdir('clawd-files') do |dir|
      git!(dir, 'init', '-b', 'main')
      git!(dir, 'config', 'user.email', 'a@b.c')
      git!(dir, 'config', 'user.name', 'x')
      File.write(File.join(dir, 'README.md'), "hello world\n")
      git!(dir, 'add', '-A')
      git!(dir, 'commit', '-m', 'init')
      @repo = dir
      example.run
    end
  end

  before do
    allow(Git::WorktreeManager).to(receive(:repo_root).and_return(@repo))
    Git::WorktreeManager.new(session).ensure_worktree!
    @wt = Git::WorktreeManager.new(session).worktree_path
  end

  describe 'GET /api/sessions/:id/files (tree)' do
    it 'returns the git ls-files tree for a participant (200)' do
      join_as(session, role: 'viewer')
      get("/api/sessions/#{session.id}/files")
      expect(response).to(have_http_status(:ok))
      expect(response.parsed_body['files']).to(include('README.md'))
    end

    it 'is refused for a non-participant with 404 (not 403)' do
      other = create(:session)
      join_as(session, role: 'owner') # participant of `session`, not `other`
      get("/api/sessions/#{other.id}/files")
      expect(response).to(have_http_status(:not_found))
    end
  end

  describe 'GET /api/sessions/:id/files/content' do
    before { join_as(session, role: 'viewer') }

    it 'returns an allowed file content (200)' do
      get("/api/sessions/#{session.id}/files/content", params: { path: 'README.md' })
      expect(response).to(have_http_status(:ok))
      expect(response.parsed_body['content']).to(eq("hello world\n"))
    end

    it 'refuses a ../ traversal with 404' do
      get("/api/sessions/#{session.id}/files/content", params: { path: '../../etc/passwd' })
      expect(response).to(have_http_status(:not_found))
    end

    it 'refuses a denylisted file with 404' do
      File.write(File.join(@wt, '.env'), "SECRET=1\n")
      get("/api/sessions/#{session.id}/files/content", params: { path: '.env' })
      expect(response).to(have_http_status(:not_found))
    end

    it 'refuses a missing file with 404' do
      get("/api/sessions/#{session.id}/files/content", params: { path: 'nope.rb' })
      expect(response).to(have_http_status(:not_found))
    end

    it 'refuses an oversized file with 413' do
      File.write(File.join(@wt, 'big.txt'), 'a' * (RepoBrowser::MAX_BYTES + 1))
      get("/api/sessions/#{session.id}/files/content", params: { path: 'big.txt' })
      expect(response).to(have_http_status(:content_too_large))
    end

    it 'refuses a binary file with 415' do
      File.binwrite(File.join(@wt, 'logo.png'), "\x89PNG\x00\x01")
      get("/api/sessions/#{session.id}/files/content", params: { path: 'logo.png' })
      expect(response).to(have_http_status(:unsupported_media_type))
    end

    it 'refuses cross-session content with 404' do
      other = create(:session)
      get("/api/sessions/#{other.id}/files/content", params: { path: 'README.md' })
      expect(response).to(have_http_status(:not_found))
    end
  end
end
