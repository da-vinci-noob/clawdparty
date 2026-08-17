# frozen_string_literal: true

require 'rails_helper'

# The per-session run defaults, set from Settings → Provider.
#
# Two things make these different from ordinary attributes:
#
#   * `aws_profile` decides WHOSE ACCOUNT PAYS. The harness has accepted a per-run profile
#     for some time and nothing ever sent one, so the choice was unreachable from the app and every
#     Bedrock run silently used the harness's env default.
#   * A default is only useful if the next run actually starts with it — a setting nothing reads is
#     the failure this whole phase keeps finding. `Runs::Start` reads them.
RSpec.describe('Session run defaults') do
  # chat mode: a review session would need a real git worktree to start a run, and what is under
  # test here is which provider/model/profile the run is started WITH.
  let(:session) { create(:session, mode: 'chat', repository_path: '/repo') }

  let(:providers) do
    { 'providers' => [
      { 'id' => 'anthropic-bedrock', 'displayName' => 'Amazon Bedrock', 'available' => true,
        'models' => [{ 'id' => 'global.anthropic.claude-sonnet-4-6', 'displayName' => 'Sonnet 4.6' }] },
      { 'id' => 'bedrock-converse', 'displayName' => 'Bedrock (Converse)', 'available' => true,
        'models' => [{ 'id' => 'us.deepseek.r1-v1:0', 'displayName' => 'R1' }] }
    ] }
  end

  before do
    allow_any_instance_of(Harness::Client).to(receive(:list_models)
      .and_return(Harness::Client::Result.new(status: 200, body: providers)))
    allow_any_instance_of(Harness::Client).to(receive(:list_aws_profiles)
      .and_return(Harness::Client::Result.new(status: 200,
                                              body: { 'profiles' => %w[claude-code-sso default],
                                                      'source' => 'host' })))
  end

  def patch_defaults(role: 'owner', **params)
    join_as(session, role: role)
    patch("/api/sessions/#{session.id}", params: params, as: :json)
  end

  describe 'PATCH /api/sessions/:id' do
    it 'stores the provider, model and AWS profile for an owner' do
      patch_defaults(default_provider: 'anthropic-bedrock',
                     default_model: 'global.anthropic.claude-sonnet-4-6',
                     aws_profile: 'claude-code-sso')

      expect(response).to(have_http_status(:ok))
      expect(session.reload).to(have_attributes(default_provider: 'anthropic-bedrock',
                                                default_model: 'global.anthropic.claude-sonnet-4-6',
                                                aws_profile: 'claude-code-sso'))
    end

    it 'returns them, so the page can show what is set' do
      patch_defaults(default_provider: 'anthropic-bedrock')
      expect(response.parsed_body).to(include('default_provider' => 'anthropic-bedrock'))
    end

    %w[editor reviewer viewer].each do |role|
      it "refuses a #{role} with 403 and changes nothing" do
        patch_defaults(role: role, aws_profile: 'claude-code-sso')

        expect(response).to(have_http_status(:forbidden))
        expect(session.reload.aws_profile).to(be_nil)
      end
    end

    it 'refuses a model the chosen provider does not serve' do
      # A model id only means something relative to its provider — the defect already fixed in the
      # composer, applied to the stored default so it cannot be saved wrong and fail at run start.
      patch_defaults(default_provider: 'anthropic-bedrock', default_model: 'us.deepseek.r1-v1:0')

      expect(response).to(have_http_status(:unprocessable_content))
      expect(session.reload.default_model).to(be_nil)
    end

    it 'refuses a provider this host does not serve' do
      patch_defaults(default_provider: 'openai-direct')
      expect(response).to(have_http_status(:unprocessable_content))
    end

    it 'refuses an AWS profile the host does not have' do
      # Enumerated rather than free text: a wrong name fails later as an opaque AWS credential
      # error, and the person who typed it has no way to know which names are valid.
      patch_defaults(aws_profile: 'not-a-profile')

      expect(response).to(have_http_status(:unprocessable_content))
      expect(session.reload.aws_profile).to(be_nil)
    end

    it 'clears a default when sent empty' do
      session.update!(default_provider: 'anthropic-bedrock')
      patch_defaults(default_provider: '')

      # "No default" has to be reachable, or a session can never go back to letting the server
      # resolve one.
      expect(session.reload.default_provider).to(be_nil)
    end

    it 'leaves the working directory alone when the request does not mention it' do
      # The hazard the key-gate prevents, and it is not hypothetical: `working_directory` defaults to
      # the REPO ROOT when the param is blank, so recomputing it on every PATCH would move a
      # session's directory to the root the moment someone set a provider default.
      session.update!(repository_path: '/repo/sub')
      patch_defaults(default_provider: 'anthropic-bedrock')

      expect(response).to(have_http_status(:ok))
      expect(session.reload.repository_path).to(eq('/repo/sub'))
    end

    it 'fails open when model discovery is unavailable' do
      # Same rule as connector/skill validation: only a value outside a KNOWN, non-empty set is a
      # 422. Otherwise a harness outage would block a settings change it has no business blocking.
      allow_any_instance_of(Harness::Client).to(receive(:list_models)
        .and_raise(Harness::Client::TransportError, 'down'))
      patch_defaults(default_provider: 'anthropic-bedrock')

      expect(response).to(have_http_status(:ok))
      expect(session.reload.default_provider).to(eq('anthropic-bedrock'))
    end
  end

  describe 'POST /api/sessions/:id/runs — the audit check' do
    # Proven over HTTP, not only in the service: the controller used to compute a model with
    # `ResolveModel` before `Runs::Start` could see the session default, so the setting was
    # unreachable through the one path that matters. A service test alone would have passed.
    let(:posted) { [] }

    before do
      session.update!(default_provider: 'anthropic-bedrock',
                      default_model: 'global.anthropic.claude-sonnet-4-6',
                      aws_profile: 'claude-code-sso')
      allow_any_instance_of(Harness::Client).to(receive(:start_run)) do |_c, payload|
        posted << payload
        Harness::Client::Result.new(status: 202, body: {})
      end
    end

    it 'starts a run with the session defaults when the composer sends none' do
      join_as(session, role: 'owner')
      post("/api/sessions/#{session.id}/runs", params: { prompt: 'go' }, as: :json)

      expect(response).to(have_http_status(:accepted))
      expect(posted.last).to(include(provider: 'anthropic-bedrock',
                                     model: 'global.anthropic.claude-sonnet-4-6',
                                     aws_profile: 'claude-code-sso'))
    end

    it 'still lets the composer override them per run' do
      join_as(session, role: 'owner')
      post("/api/sessions/#{session.id}/runs",
           params: { prompt: 'go', provider: 'bedrock-converse', model: 'us.deepseek.r1-v1:0' },
           as: :json)

      expect(posted.last).to(include(provider: 'bedrock-converse', model: 'us.deepseek.r1-v1:0'))
    end
  end

  describe 'GET /api/sessions/:id' do
    it 'exposes the defaults to every participant' do
      session.update!(default_provider: 'anthropic-bedrock', aws_profile: 'claude-code-sso')
      join_as(session, role: 'viewer')

      get("/api/sessions/#{session.id}")

      # Readable by all: knowing which account a run will bill is not an owner secret, and the
      # settings page shows the same values to everyone with the controls hidden.
      expect(response.parsed_body).to(include('default_provider' => 'anthropic-bedrock',
                                              'aws_profile' => 'claude-code-sso'))
    end
  end
end
