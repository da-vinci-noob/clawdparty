# frozen_string_literal: true

require 'rails_helper'

RSpec.describe(Sidecar::Client) do
  # Injectable HTTP: capture (uri, json) and return a canned Net::HTTP-like response.
  def fake_http(status, body = '{}')
    calls = []
    http = lambda do |uri, json|
      calls << { uri: uri, json: json }
      instance_double(Net::HTTPResponse, code: status.to_s, body: body)
    end
    [http, calls]
  end

  it 'targets the configurable SIDECAR_URL, not a hard-coded host' do
    http, calls = fake_http(202, '{"run_id":"7","status":"running"}')
    client = described_class.new(base_url: 'http://sidecar:8787', http: http)
    client.start_run({ run_id: '7' })
    expect(calls.last[:uri].to_s).to(eq('http://sidecar:8787/runs'))
  end

  it 'returns the 202 success shape on start' do
    http, = fake_http(202, '{"run_id":"7","status":"running"}')
    res = described_class.new(http: http).start_run({ run_id: '7' })
    expect(res.status).to(eq(202))
    expect(res.body).to(eq({ 'run_id' => '7', 'status' => 'running' }))
  end

  it 'raises ActiveRunConflict on 409' do
    http, = fake_http(409)
    expect { described_class.new(http: http).start_run({ run_id: '7' }) }
      .to(raise_error(Sidecar::Client::ActiveRunConflict))
  end

  it 'raises UnknownRun on 404 for messages/interrupt' do
    http, = fake_http(404)
    client = described_class.new(http: http)
    expect { client.send_message('9', message: 'hi', requested_by: '1') }
      .to(raise_error(Sidecar::Client::UnknownRun))
    expect { client.interrupt('9', requested_by: '1') }.to(raise_error(Sidecar::Client::UnknownRun))
  end

  it 'posts the frozen message/interrupt bodies' do
    http, calls = fake_http(200, '{"run_id":"9","accepted":true}')
    client = described_class.new(http: http)
    client.send_message('9', message: 'do more', requested_by: '3')
    expect(JSON.parse(calls.last[:json])).to(eq({ 'message' => 'do more', 'requested_by' => '3' }))
    client.interrupt('9', requested_by: '3')
    expect(JSON.parse(calls.last[:json])).to(eq({ 'requested_by' => '3' }))
  end
end
