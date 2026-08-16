# frozen_string_literal: true

require 'rails_helper'

RSpec.describe(Harness::Client) do
  # Injectable HTTP: capture (uri, json) and return a canned Net::HTTP-like response.
  def fake_http(status, body = '{}')
    calls = []
    http = lambda do |uri, json|
      calls << { uri: uri, json: json }
      instance_double(Net::HTTPResponse, code: status.to_s, body: body)
    end
    [http, calls]
  end

  it 'targets the configurable HARNESS_URL, not a hard-coded host' do
    http, calls = fake_http(202, '{"run_id":"7","status":"running"}')
    client = described_class.new(base_url: 'http://harness:8787', http: http)
    client.start_run({ run_id: '7' })
    expect(calls.last[:uri].to_s).to(eq('http://harness:8787/runs'))
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
      .to(raise_error(Harness::Client::ActiveRunConflict))
  end

  it 'raises UnknownRun on 404 for messages/interrupt' do
    http, = fake_http(404)
    client = described_class.new(http: http)
    expect { client.send_message('9', message: 'hi', requested_by: '1') }
      .to(raise_error(Harness::Client::UnknownRun))
    expect { client.interrupt('9', requested_by: '1') }.to(raise_error(Harness::Client::UnknownRun))
  end

  it 'posts the frozen message/interrupt bodies' do
    http, calls = fake_http(200, '{"run_id":"9","accepted":true}')
    client = described_class.new(http: http)
    client.send_message('9', message: 'do more', requested_by: '3')
    expect(JSON.parse(calls.last[:json])).to(eq({ 'message' => 'do more', 'requested_by' => '3' }))
    client.interrupt('9', requested_by: '3')
    expect(JSON.parse(calls.last[:json])).to(eq({ 'requested_by' => '3' }))
  end

  it 'GETs /connectors with the cwd query and returns the parsed body' do
    http, calls = fake_http(200, '{"connectors":[{"name":"github","transport":"stdio"}],"source":"project"}')
    # base_url injected, like the addressing test above: this example is about the
    # cwd QUERY, and reading the real HARNESS_URL made it fail when the harness moved
    # to the host — a topology change it has no opinion on.
    res = described_class.new(base_url: 'http://harness.test:8787', http: http).list_connectors(cwd: '/repo/app')
    expect(calls.last[:uri].to_s).to(eq('http://harness.test:8787/connectors?cwd=%2Frepo%2Fapp'))
    expect(calls.last[:json]).to(be_nil)
    expect(res.status).to(eq(200))
    expect(res.body['connectors'].first).to(eq({ 'name' => 'github', 'transport' => 'stdio' }))
    expect(res.body['source']).to(eq('project'))
  end

  it 'GETs /skills with the cwd query and returns the parsed body' do
    http, calls = fake_http(200, '{"skills":[{"name":"deploy","description":"Ship it"}],"source":"user"}')
    res = described_class.new(base_url: 'http://harness.test:8787', http: http).list_skills(cwd: '/repo/app')
    expect(calls.last[:uri].to_s).to(eq('http://harness.test:8787/skills?cwd=%2Frepo%2Fapp'))
    expect(res.body['skills'].first).to(eq({ 'name' => 'deploy', 'description' => 'Ship it' }))
  end

  # These bypass the `http:` seam on purpose. The seam is exactly why the missing
  # bearer went unnoticed: it replaces the code that BUILDS the request, so every
  # example above passed while no real call carried an Authorization header at all —
  # and the harness now 401s each one. Stubbing Net::HTTP instead exercises
  # the real request-building path.
  describe 'outbound authentication' do
    def capture_request
      sent = []
      transport = instance_double(Net::HTTP)
      allow(Net::HTTP).to(receive(:new).and_return(transport))
      allow(transport).to(receive(:open_timeout=))
      allow(transport).to(receive(:read_timeout=))
      allow(transport).to(receive(:request)) do |req|
        sent << req
        instance_double(Net::HTTPResponse, code: '200', body: '{}')
      end
      sent
    end

    it 'sends the shared secret as a bearer on POSTs' do
      sent = capture_request
      described_class.new(shared_secret: 'sekrit').start_run({ run_id: '1' })

      expect(sent.last['authorization']).to(eq('Bearer sekrit'))
    end

    it 'sends the shared secret as a bearer on GETs' do
      sent = capture_request
      described_class.new(shared_secret: 'sekrit').list_runs

      # GETs were the easier half to forget: perform_get built a bare request with no
      # header at all, so reconciliation  would have failed on every boot.
      expect(sent.last['authorization']).to(eq('Bearer sekrit'))
    end

    it 'keeps sending the JSON content type alongside the bearer' do
      sent = capture_request
      described_class.new(shared_secret: 'sekrit').start_run({ run_id: '1' })

      expect(sent.last['content-type']).to(eq('application/json'))
      expect(sent.last.body).to(eq({ run_id: '1' }.to_json))
    end

    it 'reads the same env var the harness authenticates with' do
      # One secret, both directions: the harness's callbacks into Rails and Rails'
      # calls into the harness. Two names would drift and the symptom would be a 401
      # that looks like a code bug.
      expect(described_class.shared_secret).to(eq(ENV.fetch('HARNESS_SHARED_SECRET', '')))
    end
  end

  it 'raises TransportError when a discovery GET fails' do
    http = ->(_uri, _json) { raise(Errno::ECONNREFUSED, 'connection refused') }
    expect { described_class.new(http: http).list_connectors(cwd: '/repo') }
      .to(raise_error(Harness::Client::TransportError))
  end
end
