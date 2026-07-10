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
    it 'lists the immediate subdirectories at the root with git markers, hiding dotdirs' do
      join_as(session, role: 'viewer')
      get('/api/directories')

      expect(response).to(have_http_status(:ok))
      body = response.parsed_body
      expect(body['path']).to(eq(''))
      names = body['entries'].pluck('name')
      expect(names).to(contain_exactly('plain', 'proj')) # no .hidden, no recursion into src
      expect(body['entries'].find { |e| e['name'] == 'proj' }['is_git_repo']).to(be(true))
      expect(body['entries'].find { |e| e['name'] == 'plain' }['is_git_repo']).to(be(false))
    end

    it 'lists into a subdirectory when given a path' do
      join_as(session, role: 'viewer')
      get('/api/directories', params: { path: 'proj' })

      expect(response).to(have_http_status(:ok))
      body = response.parsed_body
      expect(body['path']).to(eq('proj'))
      expect(body['entries'].pluck('name')).to(eq(['src']))
      expect(body['entries'].first['path']).to(eq('proj/src'))
    end

    it 'refuses a ../ traversal with 404' do
      join_as(session, role: 'viewer')
      get('/api/directories', params: { path: '../../etc' })
      expect(response).to(have_http_status(:not_found))
    end

    it 'refuses a symlink that escapes the root with 404' do
      join_as(session, role: 'viewer')
      get('/api/directories', params: { path: 'escape' })
      expect(response).to(have_http_status(:not_found))
    end

    it 'refuses an unauthenticated request with 404' do
      get('/api/directories')
      expect(response).to(have_http_status(:not_found))
    end
  end
end
