# frozen_string_literal: true

require 'net/http'
require 'json'
require 'uri'

module Harness
  # The sole Rails→harness caller for the frozen harness-protocol control surface.
  # Targets HARNESS_URL — no hard-coded host, so a remote/Tailscale rebind is a config
  # change only. The harness is a HOST process on loopback, so from this container that
  # is `host.docker.internal` (compose sets it); the default below is only a fallback.
  class Client
    class ActiveRunConflict < StandardError; end
    class UnknownRun < StandardError; end
    class TransportError < StandardError; end

    Result = Struct.new(:status, :body, keyword_init: true)

    def self.base_url
      ENV.fetch('HARNESS_URL', 'http://host.docker.internal:8787')
    end

    # The SAME secret the harness authenticates its callbacks into Rails with — one
    # value, both directions. Every outbound request carries it because the harness now
    # authenticates EVERY inbound route ; without it each call is a 401.
    def self.shared_secret
      ENV.fetch('HARNESS_SHARED_SECRET', '')
    end

    def initialize(base_url: self.class.base_url, http: nil, shared_secret: self.class.shared_secret)
      @base_url = base_url
      @http = http # injectable for tests; defaults to Net::HTTP
      @shared_secret = shared_secret
    end

    # GET /models — the models available to the host's Claude/Bedrock login,
    # discovered at runtime. The harness never 500s here (it falls back to a
    # static list), so we just return the parsed body.
    def list_models
      get('/models')
    end

    # GET /connectors?cwd= — MCP servers the host has configured for the given
    # repo path (name + transport only). Missing/unparseable config yields an
    # empty list with an unavailable source (never a 500), like list_models.
    def list_connectors(cwd:)
      get('/connectors', { cwd: cwd })
    end

    # GET /skills?cwd= — skills discovered by scanning SKILL.md files under the
    # given repo path + host ~/.claude (name + description only).
    def list_skills(cwd:)
      get('/skills', { cwd: cwd })
    end

    # GET /runs — the authoritative active-run list, read from the harness's position
    # registers. This is the  reconciliation source: the harness holds the record
    # and Rails holds a projection of it, so on a disagreement the harness wins.
    def list_runs
      get('/runs')
    end

    # GET /sessions/:id/entries?after= — the re-derivation source. `after` is
    # EXCLUSIVE. The harness serves its PROJECTION, so store-only entries never arrive
    # here and Rails does no filtering of its own.
    def list_entries(session_id, after: 0)
      get("/sessions/#{session_id}/entries", { after: after })
    end

    # POST /runs — 202 { run_id, status } on accept; 409 if a run is already active.
    def start_run(payload)
      res = post('/runs', payload)
      raise(ActiveRunConflict, 'harness reports a run already active') if res.status == 409

      res
    end

    # POST /runs/:id/messages — 200 on accept; 404 unknown / 409 not-acceptable.
    def send_message(run_id, message:, requested_by:)
      res = post("/runs/#{run_id}/messages", { message: message, requested_by: requested_by })
      raise(UnknownRun, "run #{run_id} unknown") if res.status == 404

      res
    end

    # POST /runs/:id/interrupt — 200 on accept; 404/409 otherwise.
    def interrupt(run_id, requested_by:)
      res = post("/runs/#{run_id}/interrupt", { requested_by: requested_by })
      raise(UnknownRun, "run #{run_id} unknown") if res.status == 404

      res
    end

    private

    attr_reader :base_url, :shared_secret

    def post(path, body)
      uri = URI.join(base_url, path)
      response = perform(uri, body.to_json)
      parsed = response.body.to_s.empty? ? {} : JSON.parse(response.body)
      Result.new(status: response.code.to_i, body: parsed)
    rescue JSON::ParserError
      Result.new(status: response.code.to_i, body: {})
    rescue StandardError => e
      raise(TransportError, "harness #{path} failed: #{e.message}")
    end

    def get(path, query = nil)
      uri = URI.join(base_url, path)
      uri.query = URI.encode_www_form(query) if query
      response = perform_get(uri)
      parsed = response.body.to_s.empty? ? {} : JSON.parse(response.body)
      Result.new(status: response.code.to_i, body: parsed)
    rescue JSON::ParserError
      Result.new(status: response.code.to_i, body: {})
    rescue StandardError => e
      raise(TransportError, "harness #{path} failed: #{e.message}")
    end

    def perform(uri, json)
      return @http.call(uri, json) if @http # test seam

      request = Net::HTTP::Post.new(uri)
      request['content-type'] = 'application/json'
      request.body = json
      dispatch(uri, request)
    end

    def perform_get(uri)
      return @http.call(uri, nil) if @http # test seam

      dispatch(uri, Net::HTTP::Get.new(uri))
    end

    def dispatch(uri, request)
      request['authorization'] = "Bearer #{shared_secret}"
      http = Net::HTTP.new(uri.host, uri.port)
      http.open_timeout = 5
      http.read_timeout = 15
      http.request(request)
    end
  end
end
