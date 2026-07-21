# frozen_string_literal: true

# Session-scoped capability discovery proxied from the sidecar (connectors +
# skills). Both the read-only discovery endpoints and the run-start validation
# read the same cached path, keyed by the session's repository_path so two
# sessions on the same repo share the result (mirrors GET /api/models caching,
# but per-repo). A missing/unparseable source yields an empty list with an
# unavailable source; only an unreachable sidecar raises TransportError — the
# caller decides whether that surfaces as 502 (discovery endpoints) or fails
# open (run-start validation).
module SidecarDiscovery
  extend ActiveSupport::Concern

  DISCOVERY_CACHE_TTL = 60.seconds

  private

  def discover_connectors(session)
    fetch_discovery('connectors', session) { |client, cwd| client.list_connectors(cwd: cwd) }
  end

  def discover_skills(session)
    fetch_discovery('skills', session) { |client, cwd| client.list_skills(cwd: cwd) }
  end

  def fetch_discovery(kind, session)
    cwd = session.repository_path
    Rails.cache.fetch("sidecar/#{kind}/#{cwd}", expires_in: DISCOVERY_CACHE_TTL) do
      yield(Sidecar::Client.new, cwd).body
    end
  end
end
