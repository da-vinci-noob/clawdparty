# frozen_string_literal: true

# Runtime model discovery for the run/prompt composer. Proxies the harness's
# GET /models (which enumerates the models actually available to the host's
# Claude/Bedrock login) so the web picker is never a stale hard-coded list.
# Any authenticated participant may read it — the model set is host-wide, not
# session-scoped, so there is no session to view-gate against (the route is not
# nested). The harness never 500s here (it falls back to a static list); the
# result is briefly cached so opening the composer doesn't hammer Bedrock.
#
# Shape-agnostic on purpose: it forwards the harness's `{ providers: [...] }` verbatim, so a
# per-provider field added there needs no change here. The harness does NOT fall back to a
# static model list any more — an unavailable provider arrives reported with a reason and an
# empty `models` array , which is what the picker gates on.
class ModelsController < ApplicationController
  before_action :require_user

  rescue_from Harness::Client::TransportError do
    render(json: { errors: [{ message: 'The harness is unavailable; try again' }] }, status: :bad_gateway)
  end

  # Shared with `Runs::ResolveModel`, which resolves a run's default from the same list. Two
  # independently-keyed caches can disagree for a minute, which would let the picker offer a
  # model run start then refuses.
  CACHE_KEY = 'harness/models'
  CACHE_TTL = 60.seconds

  # GET /api/models
  def index
    result = Rails.cache.fetch(CACHE_KEY, expires_in: CACHE_TTL) do
      Harness::Client.new.list_models.body
    end
    render(json: result, status: :ok)
  end
end
