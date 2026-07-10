# frozen_string_literal: true

require 'rails_helper'

RSpec.describe('POST /api/sessions (create)') do
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

  it 'stores an optional repository_path when given' do
    post('/api/sessions', params: { title: 'T', name: 'A', repository_path: '/repo' })
    expect(Session.last.repository_path).to(eq('/repo'))
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
