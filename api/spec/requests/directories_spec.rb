# frozen_string_literal: true

require 'rails_helper'
require 'open3'
require 'tmpdir'
require 'fileutils'

RSpec.describe('Directory listing API') do
  let(:session) { create(:session) }

  # A real throwaway repo root with a mix of children: a plain dir, a git repo
  # (with a nested subdir), a dotdir, and a symlink escaping the root. The tmpdir
  # lifecycle is `around`; the repo_root stub must be in `before` (mocks are not
  # supported inside `around`).
  around do |example|
    Dir.mktmpdir('clawd-dirs') do |dir|
      FileUtils.mkdir_p(File.join(dir, 'plain'))
      FileUtils.mkdir_p(File.join(dir, 'proj', 'src'))
      Open3.capture3('git', '-C', File.join(dir, 'proj'), 'init', '-b', 'main')
      FileUtils.mkdir_p(File.join(dir, '.hidden'))
      File.symlink('/etc', File.join(dir, 'escape'))
      @repo = File.realpath(dir)
      example.run
    end
  end

  before { allow(Git::WorktreeManager).to(receive(:repo_root).and_return(@repo)) }

  describe 'GET /api/directories' do
    it 'lists the configured browse roots at the synthetic top level' do
      join_as(session, role: 'viewer')
      get('/api/directories')

      expect(response).to(have_http_status(:ok))
      body = response.parsed_body
      # Blank path means the ROOT SET, not "the one root's contents". The shape is the
      # same whether one root is configured or five, so `path: ""` never means two
      # different things depending on an env var.
      expect(body['path']).to(eq(''))
      expect(body['parent']).to(be_nil)
      expect(body['entries'].pluck('path')).to(eq([@repo]))
    end

    it 'lists a root with absolute child paths, git markers, and no dotdirs' do
      join_as(session, role: 'viewer')
      get('/api/directories', params: { path: @repo })

      expect(response).to(have_http_status(:ok))
      body = response.parsed_body
      expect(body['path']).to(eq(@repo))
      # Up from a ROOT is the root list, never the filesystem parent — the client
      # cannot compute that, which is why the server sends it.
      expect(body['parent']).to(eq(''))
      expect(body['entries'].pluck('name')).to(contain_exactly('plain', 'proj'))
      expect(body['entries'].pluck('path')).to(contain_exactly("#{@repo}/plain", "#{@repo}/proj"))
      expect(body['entries'].find { |e| e['name'] == 'proj' }['is_git_repo']).to(be(true))
      expect(body['entries'].find { |e| e['name'] == 'plain' }['is_git_repo']).to(be(false))
      expect(body['is_git_repo']).to(be(false))
    end

    it 'lists into a subdirectory, flagging whether it is a git repo' do
      join_as(session, role: 'viewer')
      get('/api/directories', params: { path: File.join(@repo, 'proj') })

      expect(response).to(have_http_status(:ok))
      body = response.parsed_body
      expect(body['path']).to(eq("#{@repo}/proj"))
      expect(body['parent']).to(eq(@repo))
      expect(body['entries'].pluck('path')).to(eq(["#{@repo}/proj/src"]))
      # `proj` IS a git repo, so the picker allows "Use this folder" for review.
      expect(body['is_git_repo']).to(be(true))
    end

    it 'refuses a ../ traversal with 404' do
      join_as(session, role: 'viewer')
      get('/api/directories', params: { path: File.join(@repo, '..', '..', 'etc') })
      expect(response).to(have_http_status(:not_found))
    end

    it 'refuses a symlink that escapes every root with 404' do
      join_as(session, role: 'viewer')
      get('/api/directories', params: { path: File.join(@repo, 'escape') })
      expect(response).to(have_http_status(:not_found))
    end

    it 'omits an escaping symlink from a listing rather than showing an unusable entry' do
      join_as(session, role: 'viewer')
      get('/api/directories', params: { path: @repo })

      # `escape` -> /etc is a directory, so a listing that only checked File.directory?
      # would show it and 404 on click.
      expect(response.parsed_body['entries'].pluck('name')).not_to(include('escape'))
    end

    it 'refuses an unauthenticated request with 404' do
      get('/api/directories')
      expect(response).to(have_http_status(:not_found))
    end
  end

  describe 'multiple browse roots' do
    it 'lists every configured root and browses into each' do
      join_as(session, role: 'viewer')
      Dir.mktmpdir('clawd-second') do |other|
        second = File.realpath(other)
        FileUtils.mkdir_p(File.join(second, 'elsewhere'))
        allow(BrowseRoots).to(receive(:env_value).and_return("#{@repo}:#{second}"))

        get('/api/directories')
        expect(response.parsed_body['entries'].pluck('path')).to(contain_exactly(@repo, second))

        # A path under the SECOND root is contained by it, not rejected for being
        # outside the first.
        get('/api/directories', params: { path: File.join(second, 'elsewhere') })
        expect(response).to(have_http_status(:ok))
      end
    end

    it 'still refuses a path outside every root' do
      join_as(session, role: 'viewer')
      allow(BrowseRoots).to(receive(:env_value).and_return(@repo))

      get('/api/directories', params: { path: '/etc' })
      expect(response).to(have_http_status(:not_found))
    end

    it 'skips a configured root that does not exist instead of breaking the others' do
      join_as(session, role: 'viewer')
      allow(BrowseRoots).to(receive(:env_value).and_return("/nope/not/here:#{@repo}"))

      get('/api/directories')
      expect(response).to(have_http_status(:ok))
      expect(response.parsed_body['entries'].pluck('path')).to(eq([@repo]))
    end
  end
end
