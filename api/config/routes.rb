Rails.application.routes.draw do
  # ActionCable mounted at /~cable (per the frozen http-api-contract).
  mount ActionCable.server => "/~cable"

  # Health check for load balancers / uptime monitors.
  get "up" => "rails/health#show", as: :rails_health_check

  # Client-facing REST under the /api path prefix (path scope, not a Ruby module
  # namespace — the app module is already `Api`, so a second `Api::` controller
  # namespace would be confusing and redundant).
  scope "/api" do
    # Join a session via an invite token → signed clawd_uid cookie.
    resources :participants, only: :create

    resources :sessions, only: [] do
      # Late-joiner backfill: GET /api/sessions/:session_id/events?after=<cursor>
      resources :events, only: :index
      # Run start: POST /api/sessions/:session_id/runs
      resources :runs, only: :create
    end

    # Run control: POST /api/runs/:id/messages, POST /api/runs/:id/interrupt
    resources :runs, only: [] do
      member do
        post :messages
        post :interrupt
      end
    end
  end

  # Bearer-authed sidecar→Rails callbacks.
  namespace :internal do
    resources :events, only: :create
    post "sidecar/heartbeat", to: "heartbeats#create"
  end
end
