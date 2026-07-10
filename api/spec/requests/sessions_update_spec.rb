# frozen_string_literal: true

require 'rails_helper'
require 'tmpdir'
require 'fileutils'

RSpec.describe('PATCH /api/sessions/:id (change working dir)') do
  let(:session) { create(:session, mode: 'chat') }

  around do |example|
    Dir.mktmpdir('clawd-update') do |dir|
      FileUtils.mkdir_p(File.join(dir, 'sub'))
      @repo = File.realpath(dir)
      example.run
    end
  end

  before { allow(Git::WorktreeManager).to(receive(:repo_root).and_return(@repo)) }

  it 'lets an owner change the working directory to a contained subdir (200)' do
    join_as(session, role: 'owner')
    patch("/api/sessions/#{session.id}", params: { repository_path: 'sub' })

    expect(response).to(have_http_status(:ok))
    expect(response.parsed_body['repository_path']).to(eq(File.join(@repo, 'sub')))
    expect(session.reload.repository_path).to(eq(File.join(@repo, 'sub')))
  end

  it 'defaults a blank directory to the repo root' do
    join_as(session, role: 'owner')
    patch("/api/sessions/#{session.id}", params: { repository_path: '' })
    expect(response).to(have_http_status(:ok))
    expect(session.reload.repository_path).to(eq(@repo))
  end

  it 'refuses a non-owner with 403 and leaves the directory unchanged' do
    session.update!(repository_path: @repo)
    join_as(session, role: 'editor')
    patch("/api/sessions/#{session.id}", params: { repository_path: 'sub' })

    expect(response).to(have_http_status(:forbidden))
    expect(session.reload.repository_path).to(eq(@repo))
  end

  it 'refuses a participant of another session with 404 (anti-enumeration)' do
    other = create(:session)
    join_as(other, role: 'owner')
    patch("/api/sessions/#{session.id}", params: { repository_path: 'sub' })
    expect(response).to(have_http_status(:not_found))
  end

  it 'refuses an escaping directory with 422 and leaves the directory unchanged' do
    session.update!(repository_path: @repo)
    join_as(session, role: 'owner')
    patch("/api/sessions/#{session.id}", params: { repository_path: '../../etc' })

    expect(response).to(have_http_status(:unprocessable_content))
    expect(session.reload.repository_path).to(eq(@repo))
  end

  it 'refuses an unauthenticated request with 404' do
    patch("/api/sessions/#{session.id}", params: { repository_path: 'sub' })
    expect(response).to(have_http_status(:not_found))
  end
end
