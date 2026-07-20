# frozen_string_literal: true

require 'rails_helper'

RSpec.describe('Models API') do
  let(:session) { create(:session) }

  describe 'GET /api/models' do
    it 'returns the model list proxied from the sidecar' do
      body = { 'source' => 'bedrock',
               'models' => [{ 'id' => 'us.anthropic.claude-opus-4-8', 'label' => 'Bedrock Opus 4.8' }] }
      allow_any_instance_of(Sidecar::Client).to(receive(:list_models)
        .and_return(Sidecar::Client::Result.new(status: 200, body: body)))

      join_as(session, role: 'viewer')
      get('/api/models')

      expect(response).to(have_http_status(:ok))
      expect(response.parsed_body['source']).to(eq('bedrock'))
      expect(response.parsed_body['models'].first['id']).to(eq('us.anthropic.claude-opus-4-8'))
    end

    it 'refuses an unauthenticated request with 404' do
      get('/api/models')
      expect(response).to(have_http_status(:not_found))
    end

    it 'returns 502 when the sidecar is unreachable' do
      allow_any_instance_of(Sidecar::Client).to(receive(:list_models)
        .and_raise(Sidecar::Client::TransportError, 'sidecar /models failed: connection refused'))

      join_as(session, role: 'viewer')
      get('/api/models')
      expect(response).to(have_http_status(:bad_gateway))
    end
  end
end
