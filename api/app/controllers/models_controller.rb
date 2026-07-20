# frozen_string_literal: true

# Runtime model discovery for the run/prompt composer. Proxies the sidecar's
# GET /models (which enumerates the models actually available to the host's
# Claude/Bedrock login) so the web picker is never a stale hard-coded list.
# Any authenticated participant may read it — the model set is host-wide, not
# session-scoped, so there is no session to view-gate against (the route is not
# nested). The sidecar never 500s here (it falls back to a static list); the
# result is briefly cached so opening the composer doesn't hammer Bedrock.
class ModelsController < ApplicationController
  before_action :require_user

  rescue_from Sidecar::Client::TransportError do
    render(json: { errors: [{ message: 'The Claude sidecar is unavailable; try again' }] }, status: :bad_gateway)
  end

  CACHE_TTL = 60.seconds

  # GET /api/models
  def index
    result = Rails.cache.fetch('sidecar/models', expires_in: CACHE_TTL) do
      Sidecar::Client.new.list_models.body
    end
    render(json: result, status: :ok)
  end
end
