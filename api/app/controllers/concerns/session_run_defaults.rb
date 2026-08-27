# frozen_string_literal: true

# Validating the per-session run defaults: default provider, default model, AWS profile.
#
# Same validation posture as `RunCapabilities` (design D6) and for the same reason: only a value
# outside a KNOWN, NON-EMPTY set is a 422. If discovery is unavailable the selection passes through —
# a harness outage should not block a settings change it has no business blocking, and the run path
# validates again with a live list.
#
# A MODEL is validated against its own PROVIDER, never against the union: a model id only means
# something relative to the provider that serves it, which is the defect the composer hit when a
# Bedrock inference-profile id was sent to `anthropic-direct`. Storing that combination would move
# the failure from "cannot save" to "every run start fails", which is strictly worse.
module SessionRunDefaults
  extend ActiveSupport::Concern

  include HarnessDiscovery

  class InvalidDefault < StandardError; end

  included do
    rescue_from InvalidDefault do |error|
      render(json: { errors: [{ message: error.message }] }, status: :unprocessable_content)
    end
  end

  private

  # Only the keys the request actually sent, so a PATCH that changes the working directory does not
  # silently clear the defaults. An empty string CLEARS (stored as nil): "no default" has to stay
  # reachable, or a session can never go back to letting the server resolve one.
  def run_default_attrs(session)
    attrs = {}
    attrs[:default_provider] = params[:default_provider].presence if params.key?(:default_provider)
    attrs[:default_model] = params[:default_model].presence if params.key?(:default_model)
    attrs[:aws_profile] = params[:aws_profile].presence if params.key?(:aws_profile)
    validate_defaults!(session, attrs)
    attrs
  end

  def validate_defaults!(session, attrs)
    providers = discovered_providers(session)
    validate_provider!(attrs[:default_provider], providers) if attrs.key?(:default_provider)
    validate_model!(attrs, session, providers) if attrs[:default_model].present?
    validate_profile!(attrs[:aws_profile]) if attrs[:aws_profile].present?
  end

  def validate_provider!(provider, providers)
    return if provider.blank? || providers.nil? || providers.key?(provider)

    raise(InvalidDefault, "unknown provider: #{provider}")
  end

  # The model is checked against the provider the request is SETTING, falling back to the one already
  # stored — otherwise setting both at once would validate the new model against the old provider.
  def validate_model!(attrs, session, providers)
    return if providers.nil?

    provider = attrs.fetch(:default_provider, session.default_provider)
    return validate_against_any_provider!(attrs[:default_model], providers) if provider.blank?

    models = providers[provider]
    return if models.nil?
    return if models.include?(attrs[:default_model])

    raise(InvalidDefault, "#{provider} does not serve model #{attrs[:default_model]}")
  end

  # With no provider pinned there is no provider-relative set to check — but "NO provider on this host
  # serves this at all" is still knowable, and it is worth knowing: a typo used to save with a 200 and
  # then fail every run start, which is the outcome this file's own header argues against. Weaker than
  # the provider-relative check by design; it catches a model that does not exist, not a model paired
  # with the wrong provider.
  #
  # An EMPTY union means discovery told us nothing useful (every provider unavailable), so it passes
  # through — the same fail-open posture as `providers.nil?`, for the same reason.
  def validate_against_any_provider!(model, providers)
    known = providers.values.flatten
    return if known.empty? || known.include?(model)

    raise(InvalidDefault, "no provider on this host serves model #{model}")
  end

  def validate_profile!(profile)
    known = discovered_aws_profiles
    return if known.nil? || known.include?(profile)

    raise(InvalidDefault, "unknown AWS profile: #{profile}")
  end

  # provider id => its model ids, or nil when discovery is unavailable (the fail-open signal).
  def discovered_providers(_session)
    body = Harness::Client.new.list_models.body
    entries = Array(body['providers'])
    return nil if entries.empty?

    entries.to_h { |provider| [provider['id'], Array(provider['models']).filter_map { |m| m['id'] }] }
  rescue Harness::Client::TransportError
    nil
  end

  def discovered_aws_profiles
    body = Harness::Client.new.list_aws_profiles.body
    profiles = Array(body['profiles'])
    return nil if profiles.empty? || body['source'] == 'unavailable'

    profiles
  rescue Harness::Client::TransportError
    nil
  end
end
