# frozen_string_literal: true

# Per-run capability selection for run start (run-tools-connectors-skills):
# validate the client-supplied `disallowed_tools` / `connectors` / `skills`
# against the known/discovered sets, then thread them into Runs::Start. The
# surface is already behind the `:run` policy action in #create, so no new
# gating lives here — only validation. Kept in a concern so RunsController
# stays focused on the core run lifecycle (mirrors RunPermissionModes).
#
# Fail-open by design (design D6): if connector/skill discovery is unavailable
# (source unavailable, empty, or the sidecar is unreachable), the selection is
# passed through unvalidated — the sidecar resolves defensively and is the
# backstop. Only a value outside a *known, non-empty* set is a 422.
module RunCapabilities
  extend ActiveSupport::Concern

  include SidecarDiscovery

  class InvalidCapability < StandardError; end

  included do
    rescue_from InvalidCapability do |error|
      render(json: { errors: [{ message: error.message }] }, status: :unprocessable_content)
    end
  end

  private

  # The validated selection to hand to Runs::Start. Called after the `:run`
  # authorization, so a reviewer/viewer is already refused before we get here.
  def capability_params(session)
    {
      disallowed_tools: validated_disallowed_tools!,
      connectors: validated_connectors!(session),
      skills: validated_skills!(session)
    }
  end

  def validated_disallowed_tools!
    values = array_param(:disallowed_tools)
    reject_unknown!('tool', values, Runs::Start::DEFAULT_ALLOWED_TOOLS)
    values
  end

  def validated_connectors!(session)
    values = array_param(:connectors)
    return values if values.empty?

    known = discovered_names(:connectors, session)
    reject_unknown!('connector', values, known) unless known.nil?
    values
  end

  def validated_skills!(session)
    return 'all' if params[:skills] == 'all'

    values = array_param(:skills)
    return values if values.empty?

    known = discovered_names(:skills, session)
    reject_unknown!('skill', values, known) unless known.nil?
    values
  end

  # The discovered names for a session, or nil when discovery is unavailable
  # (source unavailable / empty / sidecar unreachable) — nil signals fail-open.
  def discovered_names(kind, session)
    body = kind == :connectors ? discover_connectors(session) : discover_skills(session)
    entries = Array(body[kind.to_s])
    return nil if body['source'] == 'unavailable' || entries.empty?

    entries.filter_map { |entry| entry['name'] }
  rescue Sidecar::Client::TransportError
    nil
  end

  def reject_unknown!(label, values, allowed)
    unknown = values - allowed
    return if unknown.empty?

    raise(InvalidCapability, "unknown #{label}(s): #{unknown.join(', ')}")
  end

  def array_param(key)
    raw = params[key]
    return [] if raw.blank?

    Array(raw).map(&:to_s)
  end
end
