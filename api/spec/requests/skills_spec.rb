# frozen_string_literal: true

require 'rails_helper'

RSpec.describe('Skills discovery API') do
  let(:session) { create(:session, repository_path: '/repo/app') }

  def stub_skills(body)
    allow_any_instance_of(Sidecar::Client).to(receive(:list_skills)
      .and_return(Sidecar::Client::Result.new(status: 200, body: body)))
  end

  describe 'GET /api/sessions/:id/skills' do
    it 'returns the skill list proxied from the sidecar (name + description)' do
      stub_skills('skills' => [{ 'name' => 'deploy', 'description' => 'Ship it' }], 'source' => 'user')

      join_as(session, role: 'viewer')
      get("/api/sessions/#{session.id}/skills")

      expect(response).to(have_http_status(:ok))
      expect(response.parsed_body['source']).to(eq('user'))
      expect(response.parsed_body['skills'].first).to(eq({ 'name' => 'deploy', 'description' => 'Ship it' }))
    end

    it 'returns an empty list (200) when the source is unavailable' do
      stub_skills('skills' => [], 'source' => 'unavailable')

      join_as(session, role: 'viewer')
      get("/api/sessions/#{session.id}/skills")

      expect(response).to(have_http_status(:ok))
      expect(response.parsed_body['skills']).to(eq([]))
      expect(response.parsed_body['source']).to(eq('unavailable'))
    end

    it 'returns 502 when the sidecar is unreachable' do
      allow_any_instance_of(Sidecar::Client).to(receive(:list_skills)
        .and_raise(Sidecar::Client::TransportError, 'sidecar /skills failed: connection refused'))

      join_as(session, role: 'viewer')
      get("/api/sessions/#{session.id}/skills")
      expect(response).to(have_http_status(:bad_gateway))
    end

    it 'refuses a cross-session (non-participant) request with 404' do
      other = create(:session, repository_path: '/repo/other')
      join_as(session, role: 'viewer')
      get("/api/sessions/#{other.id}/skills")
      expect(response).to(have_http_status(:not_found))
    end

    it 'refuses an unauthenticated request with 404' do
      get("/api/sessions/#{session.id}/skills")
      expect(response).to(have_http_status(:not_found))
    end
  end
end
