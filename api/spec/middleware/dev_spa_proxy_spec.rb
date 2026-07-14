# frozen_string_literal: true

require 'rails_helper'
require Rails.root.join('app/middleware/dev_spa_proxy')

RSpec.describe(DevSpaProxy) do
  let(:downstream) { ->(_env) { [200, { 'x-rails' => '1' }, ['rails-handled']] } }
  # Point at a closed port so "upstream unreachable" is deterministic.
  let(:middleware) { described_class.new(downstream, upstream: 'http://127.0.0.1:1') }

  def call(path, opts = {})
    middleware.call(Rack::MockRequest.env_for(path, opts))
  end

  it 'serves /api itself (Rails-owned, never proxied)' do
    status, _headers, body = call('/api/sessions/1/events')
    expect(status).to(eq(200))
    expect(body.first).to(eq('rails-handled'))
  end

  it 'serves /~cable itself (Rails-owned, never proxied)' do
    status, = call('/~cable')
    expect(status).to(eq(200))
  end

  it 'proxies a non-API path to vite and returns 502 when the upstream is unreachable' do
    status, _headers, body = call('/index.html')
    expect(status).to(eq(502))
    expect(body.first).to(include('Bad Gateway'))
  end

  it 'treats the SPA root as proxied (not Rails-owned)' do
    status, = call('/')
    expect(status).to(eq(502)) # would proxy to vite; unreachable here
  end

  it 'returns 502 for an HMR WebSocket upgrade when rack.hijack is unavailable' do
    status, _headers, body = call('/', 'HTTP_UPGRADE' => 'websocket')
    expect(status).to(eq(502))
    expect(body.first).to(include('rack.hijack')) # tunnel path, not the Net::HTTP 502
  end

  it 'does not tunnel a WebSocket upgrade on a Rails-owned path (/~cable)' do
    status, _headers, body = call('/~cable', 'HTTP_UPGRADE' => 'websocket')
    expect(status).to(eq(200)) # handled downstream by Rails (ActionCable), never tunneled
    expect(body.first).to(eq('rails-handled'))
  end
end
