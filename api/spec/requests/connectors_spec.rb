# frozen_string_literal: true

require 'rails_helper'

RSpec.describe('Connectors discovery API') do
  let(:session) { create(:session, repository_path: '/repo/app') }

  def stub_connectors(body)
    allow_any_instance_of(Sidecar::Client).to(receive(:list_connectors)
      .and_return(Sidecar::Client::Result.new(status: 200, body: body)))
  end

  describe 'GET /api/sessions/:id/connectors' do
    it 'returns the connector list proxied from the sidecar (name + transport only)' do
      stub_connectors('connectors' => [{ 'name' => 'github', 'transport' => 'stdio' }], 'source' => 'project')

      join_as(session, role: 'viewer')
      get("/api/sessions/#{session.id}/connectors")

      expect(response).to(have_http_status(:ok))
      expect(response.parsed_body['source']).to(eq('project'))
      expect(response.parsed_body['connectors'].first).to(eq({ 'name' => 'github', 'transport' => 'stdio' }))
    end

    it 'resolves against the session repository_path' do
      client = instance_double(Sidecar::Client)
      allow(client).to(receive(:list_connectors)
        .and_return(Sidecar::Client::Result.new(status: 200, body: { 'connectors' => [], 'source' => 'unavailable' })))
      allow(Sidecar::Client).to(receive(:new).and_return(client))

      join_as(session, role: 'viewer')
      get("/api/sessions/#{session.id}/connectors")

      expect(client).to(have_received(:list_connectors).with(cwd: '/repo/app'))
    end

    it 'returns an empty list (200) when the source is unavailable' do
      stub_connectors('connectors' => [], 'source' => 'unavailable')

      join_as(session, role: 'viewer')
      get("/api/sessions/#{session.id}/connectors")

      expect(response).to(have_http_status(:ok))
      expect(response.parsed_body['connectors']).to(eq([]))
      expect(response.parsed_body['source']).to(eq('unavailable'))
    end

    it 'returns 502 when the sidecar is unreachable (not a fabricated empty list)' do
      allow_any_instance_of(Sidecar::Client).to(receive(:list_connectors)
        .and_raise(Sidecar::Client::TransportError, 'sidecar /connectors failed: connection refused'))

      join_as(session, role: 'viewer')
      get("/api/sessions/#{session.id}/connectors")
      expect(response).to(have_http_status(:bad_gateway))
    end

    it 'refuses a cross-session (non-participant) request with 404' do
      other = create(:session, repository_path: '/repo/other')
      join_as(session, role: 'viewer') # participant of `session`, not `other`
      get("/api/sessions/#{other.id}/connectors")
      expect(response).to(have_http_status(:not_found))
    end

    it 'refuses an unauthenticated request with 404' do
      get("/api/sessions/#{session.id}/connectors")
      expect(response).to(have_http_status(:not_found))
    end
  end
end
