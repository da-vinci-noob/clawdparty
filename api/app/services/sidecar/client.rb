# frozen_string_literal: true

require 'net/http'
require 'json'
require 'uri'

module Sidecar
  # The sole Rails→sidecar caller for the frozen sidecar-protocol control surface.
  # Targets SIDECAR_URL (default http://sidecar:8787 over the compose network) —
  # no hard-coded host, so a remote/Tailscale rebind is a config change only.
  class Client
    class ActiveRunConflict < StandardError; end
    class UnknownRun < StandardError; end
    class RunNotActive < StandardError; end
    class TransportError < StandardError; end

    Result = Struct.new(:status, :body, keyword_init: true)

    def self.base_url
      ENV.fetch('SIDECAR_URL', 'http://sidecar:8787')
    end

    def initialize(base_url: self.class.base_url, http: nil)
      @base_url = base_url
      @http = http # injectable for tests; defaults to Net::HTTP
    end

    # GET /models — the models available to the host's Claude/Bedrock login,
    # discovered at runtime. The sidecar never 500s here (it falls back to a
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

    # POST /runs — 202 { run_id, status } on accept; 409 if a run is already active.
    def start_run(payload)
      res = post('/runs', payload)
      raise(ActiveRunConflict, 'sidecar reports a run already active') if res.status == 409

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

    # POST /runs/:id/permission_mode — 200 { run_id, permission_mode } on switch;
    # 404 unknown; 409 when the run is no longer active (caller falls back to a run).
    def set_permission_mode(run_id, permission_mode:, requested_by:)
      res = post("/runs/#{run_id}/permission_mode",
                 { permission_mode: permission_mode, requested_by: requested_by })
      raise(UnknownRun, "run #{run_id} unknown") if res.status == 404
      raise(RunNotActive, "run #{run_id} not active") if res.status == 409

      res
    end

    private

    attr_reader :base_url

    def post(path, body)
      uri = URI.join(base_url, path)
      response = perform(uri, body.to_json)
      parsed = response.body.to_s.empty? ? {} : JSON.parse(response.body)
      Result.new(status: response.code.to_i, body: parsed)
    rescue JSON::ParserError
      Result.new(status: response.code.to_i, body: {})
    rescue StandardError => e
      raise(TransportError, "sidecar #{path} failed: #{e.message}")
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
      raise(TransportError, "sidecar #{path} failed: #{e.message}")
    end

    def perform(uri, json)
      return @http.call(uri, json) if @http # test seam

      http = Net::HTTP.new(uri.host, uri.port)
      http.open_timeout = 5
      http.read_timeout = 15
      request = Net::HTTP::Post.new(uri)
      request['content-type'] = 'application/json'
      request.body = json
      http.request(request)
    end

    def perform_get(uri)
      return @http.call(uri, nil) if @http # test seam

      http = Net::HTTP.new(uri.host, uri.port)
      http.open_timeout = 5
      http.read_timeout = 15
      http.request(Net::HTTP::Get.new(uri))
    end
  end
end
