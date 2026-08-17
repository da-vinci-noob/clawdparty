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

    # Runtime model discovery (any participant): the models available to the host's
    # provider login, proxied from the harness. GET /api/models
    get 'models', to: 'models#index'
    # The auth test: sends a real request per provider, so it is a POST, not a read.
    post 'providers/verify', to: 'providers#verify'
    # Profile NAMES for the Bedrock setting; never a credential value.
    get 'aws-profiles', to: 'aws_profiles#index'

    # Create a session (unauthenticated LAN bootstrap; creator becomes owner +
    # gets the cookie). #update (owner only) changes the working dir: PATCH /api/sessions/:id.
    # #index lists the caller's sessions (host or participant): GET /api/sessions.
    # #show gives one session's mode + working dir to any participant: GET /api/sessions/:id
    # — the web needs `mode` to know whether a review affordance applies at all.
    # member #archive hard-closes a session (owner only): POST /api/sessions/:id/archive.
    resources :sessions, only: %i[index show create update] do
      member do
        post :archive
      end
      # Who am I in this session (re-hydrate the client from the clawd_uid cookie
      # after a refresh): GET /api/sessions/:session_id/participant
      get 'participant', to: 'participants#show'
      # Invite management (owner only): mint/list/revoke /api/sessions/:session_id/invites[/:id]
      resources :invites, only: %i[create index destroy]
      # Late-joiner backfill: GET /api/sessions/:session_id/events?after=<cursor>
      resources :events, only: :index
      # Run start: POST /api/sessions/:session_id/runs
      resources :runs, only: :create
      # Session-scoped capability discovery (any participant), proxied + cached
      # from the harness against the session's repo path:
      # GET /api/sessions/:session_id/connectors|skills
      get 'connectors', to: 'connectors#index'
      get 'skills', to: 'skills#index'
      # Managing skills is OWNER-only: a skill is instructions Claude follows, and these are
      # the app's only writes outside a session worktree. The DELETE renames aside, never unlinks.
      post 'skills', to: 'skills#create'
      delete 'skills/:id', to: 'skills#destroy'

      # Extensions. Reading is open to any participant — which gate is in force decides what
      # Claude may do, so a viewer watching a refusal should be able to see the rule. Toggling is
      # owner-only, the same gate as skills, and for the same reason.
      get 'plugins', to: 'plugins#index'
      patch 'plugins/:id', to: 'plugins#update'
      # Chat: POST /api/sessions/:session_id/messages
      resources :messages, only: :create
      # Read-only repo browse: GET /api/sessions/:session_id/files (tree) and
      # GET /api/sessions/:session_id/files/content?path=… (content via RepoBrowser).
      get 'files', to: 'files#index'
      get 'files/content', to: 'files#content'
      # Projection repair + audit (owner only): the record is the harness's, `events` is
      # a view of it, so a gap here is repairable rather than lost.
      # GET  /api/sessions/:session_id/projection/check
      # POST /api/sessions/:session_id/projection/rederive
      get 'projection/check', to: 'projections#check'
      post 'projection/rederive', to: 'projections#rederive'
    end

    # Run control: POST /api/runs/:id/messages, POST /api/runs/:id/interrupt
    resources :runs, only: [] do
      member do
        post :messages
        post :interrupt
        # Switch Claude's permission mode mid-run (plan → execute).
        # Review loop (owner-gated): keep or revert the run's changeset.
        post :approve
        post :reject
        # Run diff (REST only, never cable): GET /api/runs/:id/diff
        get :diff
      end
    end
  end

  # Bearer-authed harness→Rails callbacks.
  namespace :internal do
    resources :events, only: :create
    post 'harness/heartbeat', to: 'heartbeats#create'
  end
end
