# frozen_string_literal: true

require 'rails_helper'
require 'open3'
require 'tmpdir'
require 'fileutils'

RSpec.describe('POST /api/sessions (create)') do
  # The test env has no bind-mounted /repo, so stub the repo root to a real
  # temp dir — session create realpath-resolves it as the default working dir.
  # review mode needs a git worktree base, so the shared root is a real git repo
  # WITH a commit (a blank review dir defaults to this root → valid).
  around do |example|
    Dir.mktmpdir('clawd-sessions') do |dir|
      init_git_repo!(dir)
      @repo = File.realpath(dir)
      example.run
    end
  end

  before { allow(Git::WorktreeManager).to(receive(:repo_root).and_return(@repo)) }

  def git!(dir, *args)
    out, err, status = Open3.capture3('git', '-C', dir, *args)
    raise("git #{args.join(' ')} failed: #{err}#{out}") unless status.success?
  end

  def init_git_repo!(dir)
    git!(dir, 'init', '-b', 'main')
    git!(dir, 'config', 'user.email', 'a@b.c')
    git!(dir, 'config', 'user.name', 'x')
    File.write(File.join(dir, 'README.md'), "seed\n")
    git!(dir, 'add', '-A')
    git!(dir, 'commit', '-m', 'init')
  end

  it 'creates a session + owner participant + host user and issues the clawd_uid cookie' do
    expect do
      post('/api/sessions', params: { title: 'Ship the thing', name: 'Alice' })
    end.to(change(Session, :count).by(1).and(change(Participant, :count).by(1)))

    expect(response).to(have_http_status(:created))
    body = response.parsed_body
    expect(body['role']).to(eq('owner'))
    expect(body['name']).to(eq('Alice'))
    expect(body['session_id']).to(eq(Session.last.id.to_s))
    expect(response.headers['Set-Cookie']).to(include('clawd_uid'))
    expect(response.headers['Set-Cookie']).not_to(include('secure'))

    session = Session.last
    expect(session.title).to(eq('Ship the thing'))
    expect(session.host.name).to(eq('Alice'))
    expect(session.participants.sole.role).to(eq('owner'))
  end

  it 'stores an optional repository_path when given (resolved + contained)' do
    proj = File.join(@repo, 'proj')
    FileUtils.mkdir_p(proj)
    init_git_repo!(proj) # git repo required for a review-mode working dir
    post('/api/sessions', params: { title: 'T', name: 'A', repository_path: 'proj' })
    expect(Session.last.repository_path).to(eq(proj))
  end

  it 'emits a participant_joined event carrying the name + role (for client attribution)' do
    post('/api/sessions', params: { title: 'T', name: 'Alice' })
    event = Session.last.events.find_by(event_type: 'participant_joined')
    expect(event).to(be_present)
    expect(event.payload).to(include('name' => 'Alice', 'role' => 'owner'))
  end

  describe 'run mode (review default | chat)' do
    it 'defaults to review mode' do
      post('/api/sessions', params: { title: 'T', name: 'A' })
      expect(Session.last.mode).to(eq('review'))
    end

    it 'refuses a REVIEW session whose working directory is not a git repository (422)' do
      # Review needs a git worktree; a contained but non-git subdir has no repo.
      # Reject at CREATE with a clear error rather than letting the run fail later
      # with a worktree GitError. (Blank defaults to the root, which IS a git repo.)
      FileUtils.mkdir_p(File.join(@repo, 'plain'))
      expect do
        post('/api/sessions', params: { title: 'T', name: 'A', repository_path: 'plain' }) # defaults to review
      end.not_to(change(Session, :count))
      expect(response).to(have_http_status(:unprocessable_content))
    end

    it 'creates a REVIEW session when the working directory is a git repository' do
      repo_sub = File.join(@repo, 'repo_sub')
      FileUtils.mkdir_p(repo_sub)
      init_git_repo!(repo_sub)
      post('/api/sessions', params: { title: 'T', name: 'A', repository_path: 'repo_sub' })
      expect(response).to(have_http_status(:created))
      expect(Session.last.repository_path).to(eq(repo_sub))
    end

    it 'creates a chat session with the repo root as the default working dir' do
      post('/api/sessions', params: { title: 'T', name: 'A', mode: 'chat' })
      expect(response).to(have_http_status(:created))
      session = Session.last
      expect(session.mode).to(eq('chat'))
      expect(session.repository_path).to(eq(File.realpath(Git::WorktreeManager.repo_root)))
    end

    it 'refuses an unknown mode with 422' do
      expect do
        post('/api/sessions', params: { title: 'T', name: 'A', mode: 'wild' })
      end.not_to(change(Session, :count))
      expect(response).to(have_http_status(:unprocessable_content))
    end

    it 'refuses a chat working directory that escapes the repo root with 422' do
      expect do
        post('/api/sessions', params: { title: 'T', name: 'A', mode: 'chat', repository_path: '../../etc' })
      end.not_to(change(Session, :count))
      expect(response).to(have_http_status(:unprocessable_content))
    end

    it 'refuses a REVIEW working directory that escapes the repo root with 422 (contained for both modes)' do
      expect do
        post('/api/sessions', params: { title: 'T', name: 'A', repository_path: '../../etc' })
      end.not_to(change(Session, :count))
      expect(response).to(have_http_status(:unprocessable_content))
    end

    it 'defaults a blank review working directory to the resolved repo root' do
      post('/api/sessions', params: { title: 'T', name: 'A', repository_path: '' })
      expect(response).to(have_http_status(:created))
      expect(Session.last.repository_path).to(eq(File.realpath(Git::WorktreeManager.repo_root)))
    end
  end

  it 'refuses a blank title with 422 and creates nothing' do
    expect do
      post('/api/sessions', params: { title: '  ', name: 'Alice' })
    end.not_to(change(Session, :count))
    expect(response).to(have_http_status(:unprocessable_content))
  end

  it 'refuses a blank name with 422' do
    expect do
      post('/api/sessions', params: { title: 'T', name: '' })
    end.not_to(change(Session, :count))
    expect(response).to(have_http_status(:unprocessable_content))
  end

  it 'requires no prior auth (bootstrap entry point on the trusted LAN)' do
    post('/api/sessions', params: { title: 'T', name: 'A' })
    expect(response).to(have_http_status(:created))
  end
end
