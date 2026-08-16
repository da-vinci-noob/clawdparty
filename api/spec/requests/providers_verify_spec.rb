# frozen_string_literal: true

require 'rails_helper'

# The auth test. `GET /api/models` reports PRESENCE — a credential was found — and that is
# not the same claim as "a run would be accepted": measured on a real host, `nova-premier` refuses
# an entitled-looking credential and a correctly-configured MCP server answered `invalid_token`.
# This endpoint proxies the harness's real per-provider request.
RSpec.describe('Providers auth test') do
  let(:session) { create(:session) }
  let(:body) do
    {
      'providers' => [
        { 'id' => 'anthropic-bedrock', 'displayName' => 'Amazon Bedrock', 'ok' => true,
          'model' => 'us.anthropic.claude-opus-4-1-20250805-v1:0',
          'credentialSource' => 'env:AWS_PROFILE',
          'usage' => { 'input_tokens' => 0, 'output_tokens' => 1 }, 'durationMs' => 7570 },
        { 'id' => 'anthropic-direct', 'displayName' => 'Anthropic (direct)', 'ok' => false,
          'reason' => 'unreachable', 'remedy' => 'Check network access' }
      ]
    }
  end

  def stub_verify(result = Harness::Client::Result.new(status: 200, body: body))
    allow_any_instance_of(Harness::Client).to(receive(:verify_providers).and_return(result))
  end

  describe 'POST /api/providers/verify' do
    it 'returns each provider verdict from the harness' do
      stub_verify
      join_as(session, role: 'viewer')

      post('/api/providers/verify')

      expect(response).to(have_http_status(:ok))
      verdicts = response.parsed_body['providers']
      expect(verdicts.first).to(include('id' => 'anthropic-bedrock', 'ok' => true))
      expect(verdicts.last).to(include('ok' => false, 'reason' => 'unreachable'))
    end

    it 'is readable by any participant, since providers are host-wide' do
      # Not session-nested: there is no session to view-gate against, and a viewer who cannot
      # diagnose a provider failure has to ask someone else to look.
      stub_verify
      join_as(session, role: 'viewer')

      post('/api/providers/verify')
      expect(response).to(have_http_status(:ok))
    end

    it 'refuses an unauthenticated request with 404' do
      post('/api/providers/verify')
      expect(response).to(have_http_status(:not_found))
    end

    it 'returns 502 when the harness is unreachable' do
      allow_any_instance_of(Harness::Client).to(receive(:verify_providers)
        .and_raise(Harness::Client::TransportError, 'harness /verify failed: connection refused'))
      join_as(session, role: 'viewer')

      post('/api/providers/verify')

      expect(response).to(have_http_status(:bad_gateway))
      expect(response.parsed_body['errors'].first['message']).to(match(/harness is unavailable/i))
    end

    it 'does not cache — a stale auth test is worse than none' do
      # The reason to open this tab is that something just changed (an expired SSO login, a new
      # profile). Serving a cached verdict would answer the question nobody asked.
      calls = 0
      allow_any_instance_of(Harness::Client).to(receive(:verify_providers)) do
        calls += 1
        Harness::Client::Result.new(status: 200, body: body)
      end
      join_as(session, role: 'viewer')

      post('/api/providers/verify')
      post('/api/providers/verify')

      expect(calls).to(eq(2))
    end
  end
end
