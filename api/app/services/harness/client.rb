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
    # The harness ANSWERED, and refused. Distinct from TransportError (unreachable) because
    # the two need different messages: this one carries the harness's own reason, which is the
    # only part that tells an operator what to fix.
    class Refused < StandardError; end
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

    # GET /models — every configured provider and the models it can serve on this host,
    # discovered at runtime. Never 500s: an unavailable provider is REPORTED with a reason and
    # a remedy rather than omitted. It does NOT fall back to a static model list —
    # a guessed id is one the host may not serve, which is what  forbids.
    def list_models
      get('/models')
    end

    # POST /verify — one tiny REAL request per provider, which is the only thing that separates
    # "a credential is present" (what /models reports) from "it is accepted". See ProvidersController.
    def verify_providers
      post('/verify', {})
    end

    # GET /aws-profiles — profile NAMES from ~/.aws/config; the harness never opens ~/.aws/credentials,
    # so no credential value is read. Enumerated so the setting is a choice among what exists.
    def list_aws_profiles
      get('/aws-profiles')
    end

    # GET /plugins?session_id= — every bundled contributor, with whether this session has it on.
    # Session-scoped so `enabled` is a real boolean rather than null.
    def list_plugins(session_id)
      get('/plugins', session_id: session_id)
    end

    # POST /sessions/:id/plugins — the RECORD half of a toggle. The harness writes the
    # `session.plugins` register; Rails appends the event, because a plugin toggle belongs to no run
    # and the harness allocates seq per run.
    def set_plugin_enabled(session_id, plugin_id:, enabled:)
      post("/sessions/#{session_id}/plugins", { plugin_id: plugin_id, enabled: enabled })
    end

    # POST /skills — write a SKILL.md into the repo's `.claude/skills` or the host's. The harness
    # validates the name as a strict single segment, so a write cannot land outside the root.
    def add_skill(cwd:, scope:, name:, description:, body:, replace: false)
      post('/skills', { cwd: cwd, scope: scope, name: name, description: description,
                        body: body, replace: replace })
    end

    # POST /skills/remove — MOVES the skill aside (rename), never deletes it, so it is a POST.
    def remove_skill(cwd:, scope:, name:)
      post('/skills/remove', { cwd: cwd, scope: scope, name: name })
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
    #
    # Any 2xx is acceptance; anything else refuses. The status used to come back in a `Result`
    # nobody read, so a harness 500 — an incompatible store schema, say — produced a `queued`
    # AiRun, a `202 Accepted` to the browser, and 15 seconds later a swept `run_failed` reading
    # `harness_unreachable`. That last part is a lie the participant then has to debug: the
    # harness was reachable and said exactly what was wrong.
    #
    # 2xx rather than `== 202` deliberately. The contract says 202 and the harness sends it,
    # but treating a 200 as refusal would DESTROY an AiRun for a run the harness had actually
    # started — an orphan on the harness side and a session that looks idle. Being wrong in
    # that direction is worse than tolerating a status the contract does not use.
    def start_run(payload)
      res = post('/runs', payload)
      raise(ActiveRunConflict, 'harness reports a run already active') if res.status == 409
      raise(Refused, refusal_reason(res)) unless res.status.between?(200, 299)

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

    # Fastify puts a thrown message in `message`; a route that refuses deliberately uses
    # `error`. Either beats a bare status, which explains nothing.
    def refusal_reason(res)
      body = res.body
      detail = body.is_a?(Hash) ? (body['message'] || body['error'] || body['detail']) : nil
      detail.presence || "the harness returned #{res.status}"
    end

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
