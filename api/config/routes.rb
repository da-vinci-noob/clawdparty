# frozen_string_literal: true

Rails.application.routes.draw do
  # ActionCable mounted at /~cable (per the frozen http-api-contract).
  mount ActionCable.server => '/~cable'

  # Health check for load balancers / uptime monitors.
  get 'up' => 'rails/health#show', as: :rails_health_check

  # Client-facing REST under the /api path prefix (path scope, not a Ruby module
  # namespace — the app module is already `Api`, so a second `Api::` controller
  # namespace would be confusing and redundant).
  scope '/api' do
    # Join a session via an invite token → signed clawd_uid cookie.
    resources :participants, only: :create

    # Folder picker: git-flagged immediate subdirs under the repo root (any
    # participant). GET /api/directories?path=…
    get 'directories', to: 'directories#index'

    # Create a session (unauthenticated LAN bootstrap; creator becomes owner +
    # gets the cookie). #update (owner only) changes the working dir: PATCH /api/sessions/:id
    resources :sessions, only: %i[create update] do
      # Who am I in this session (re-hydrate the client from the clawd_uid cookie
      # after a refresh): GET /api/sessions/:session_id/participant
      get 'participant', to: 'participants#show'
      # Mint a role-scoped invite token (owner only): POST /api/sessions/:session_id/invites
      resources :invites, only: :create
      # Late-joiner backfill: GET /api/sessions/:session_id/events?after=<cursor>
      resources :events, only: :index
      # Run start: POST /api/sessions/:session_id/runs
      resources :runs, only: :create
      # Chat: POST /api/sessions/:session_id/messages
      resources :messages, only: :create
      # Read-only repo browse: GET /api/sessions/:session_id/files (tree) and
      # GET /api/sessions/:session_id/files/content?path=… (content via RepoBrowser).
      get 'files', to: 'files#index'
      get 'files/content', to: 'files#content'
    end

    # Run control: POST /api/runs/:id/messages, POST /api/runs/:id/interrupt
    resources :runs, only: [] do
      member do
        post :messages
        post :interrupt
        # Review loop (owner-gated): keep or revert the run's changeset.
        post :approve
        post :reject
        # Run diff (REST only, never cable): GET /api/runs/:id/diff
        get :diff
      end
    end
  end

  # Bearer-authed sidecar→Rails callbacks.
  namespace :internal do
    resources :events, only: :create
    post 'sidecar/heartbeat', to: 'heartbeats#create'
  end
end
