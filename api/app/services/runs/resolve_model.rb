# frozen_string_literal: true

module Runs
  # Resolve which model a run uses, from what the host can ACTUALLY serve.
  #
  # This replaced `ENV.fetch('ANTHROPIC_MODEL', 'claude-opus-4-8')`. The literal was wrong in a
  # way that only showed on some hosts: Bedrock model ids are account-specific inference
  # profiles (`anthropic.`-prefixed), so a bare first-party id is REJECTED there. On a
  # Bedrock-only host every run that did not name a model failed at dispatch on an invalid id —
  # and the web picker's comment claimed the default "always works".
  #
  # Order, and why:
  #
  #   1. What the participant asked for. Never second-guessed here; validating it against the
  #      provider's list happens elsewhere, and silently substituting would run a different model
  #      than the one the picker showed.
  #   2. `ANTHROPIC_MODEL`, but ONLY if the chosen provider actually lists it. An operator
  #      setting it for a first-party login should not have it silently applied to Bedrock.
  #   3. The provider's first listed model — a real id from a real discovery.
  #
  # Raises when nothing can be resolved, because the alternative is a run that fails later with
  # a provider error that does not mention the cause.
  class ResolveModel
    class Unresolvable < StandardError; end

    # The SAME key ModelsController uses, so the picker and run start cannot disagree.
    CACHE_KEY = ModelsController::CACHE_KEY
    CACHE_TTL = 60.seconds

    def self.call(...) = new(...).call

    def initialize(provider:, requested: nil, client: Harness::Client.new)
      @provider = provider
      @requested = requested.presence
      @client = client
    end

    def call
      return @requested if @requested

      configured = ENV.fetch('ANTHROPIC_MODEL', nil).presence
      return configured if configured && served?(configured)

      first_served or raise(Unresolvable, unresolvable_message)
    end

    private

    attr_reader :provider, :client

    def served?(model_id) = model_ids.include?(model_id)

    def first_served = model_ids.first

    def model_ids
      @model_ids ||= Array(provider_status&.dig('models')).filter_map { |m| m['id'] }
    end

    # The provider the run named. An unavailable one contributes no models, so its `available`
    # flag needs no separate check — but it does carry the remedy this class reports.
    def provider_status
      @provider_status ||= providers.find { |p| p['id'] == provider }
    end

    def providers
      # Shares ModelsController's cache key deliberately: the picker and run start must agree
      # on what the host serves, and two independently-timed fetches can disagree for a minute.
      body = Rails.cache.fetch(CACHE_KEY, expires_in: CACHE_TTL) { client.list_models.body }
      Array(body.is_a?(Hash) ? (body['providers'] || body[:providers]) : nil)
    rescue Harness::Client::TransportError
      []
    end

    def unresolvable_message
      status = provider_status
      return "provider #{provider.inspect} is not offered by the harness" if status.nil?

      remedy = status['remedy'].presence
      base = "provider #{provider.inspect} lists no models this host can serve"
      remedy ? "#{base}: #{remedy}" : base
    end
  end
end
