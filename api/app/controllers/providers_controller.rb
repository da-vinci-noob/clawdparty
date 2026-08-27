# frozen_string_literal: true

# The auth test: does each provider actually work, right now?
#
# `GET /api/models` reports PRESENCE — a credential and a region were found — which is what the
# model picker needs and is not what "will my run work?" means. Two measured cases where presence
# said yes and the request said no: an entitlement refusal on `nova-premier` with a valid
# credential, and a correctly-configured MCP server answering `invalid_token`. So this proxies the
# harness's POST /verify, which sends one tiny real request per provider.
#
# Any authenticated participant may run it, like `GET /api/models`: the route is not session-nested
# (providers are host-wide, so there is no session to view-gate against), and the cost is a handful
# of tokens. It is deliberately NOT cached — a stale auth test is worse than no auth test, because
# the whole reason to open it is that something just changed.
class ProvidersController < ApplicationController
  before_action :require_user

  rescue_from Harness::Client::TransportError do
    render(json: { errors: [{ message: 'The harness is unavailable; try again' }] }, status: :bad_gateway)
  end

  # POST /api/providers/verify
  def verify
    body = Harness::Client.new.verify_providers.body
    # DROP the cached model list: this just learned something better than it knows. Discovery is a
    # 60-second snapshot of what was FOUND; a verdict comes from a real request that was sent. Holding
    # both let the panel show a provider as UNAVAILABLE beside VERIFIED — seen in the running app on
    # Bedrock Converse, badged unavailable with a credential and a successful test on screen.
    #
    # Deleting rather than overwriting: the verify response is a different shape (verdicts, not model
    # lists), so the next reader must re-derive discovery instead of being handed a translation of it.
    # `:memory_store` is per-PROCESS: this clears the only copy while Puma runs in single mode, and
    # would clear just one worker's if `WEB_CONCURRENCY` were ever set.
    Rails.cache.delete(ModelsController::CACHE_KEY)
    render(json: body, status: :ok)
  end
end
