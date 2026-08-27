# frozen_string_literal: true

require 'rails_helper'

# a run uses a model the host can actually serve.
#
# This replaced `ENV.fetch('ANTHROPIC_MODEL', 'claude-opus-4-8')`. The literal was wrong in a
# way that only appeared on some hosts: Bedrock model ids are account-specific inference
# profiles, so a bare first-party id is rejected there and every run that named no model died
# at dispatch on an invalid id. The existing run specs never caught it because they all pass an
# explicit `model` — which is exactly the path this file does NOT exercise.
RSpec.describe(Runs::ResolveModel) do
  let(:direct) do
    {
      'id' => 'anthropic-direct', 'displayName' => 'Anthropic (direct)', 'available' => true,
      'credentialSource' => 'env:ANTHROPIC_API_KEY',
      'models' => [
        { 'id' => 'claude-opus-5', 'displayName' => 'Claude Opus 5' },
        { 'id' => 'claude-sonnet-5', 'displayName' => 'Claude Sonnet 5' }
      ]
    }
  end

  let(:bedrock) do
    {
      'id' => 'anthropic-bedrock', 'displayName' => 'Amazon Bedrock', 'available' => true,
      'models' => [{ 'id' => 'anthropic.claude-opus-5', 'displayName' => 'Opus 5 (Bedrock)' }]
    }
  end

  let(:bedrock_broken) do
    {
      'id' => 'anthropic-bedrock', 'displayName' => 'Amazon Bedrock', 'available' => false,
      'reason' => 'unreachable',
      'remedy' => 'Run `aws sso login` — the harness cannot refresh an expired SSO session.',
      'models' => []
    }
  end

  def client_for(providers)
    client = instance_double(Harness::Client)
    allow(client).to(receive(:list_models)
      .and_return(Harness::Client::Result.new(status: 200, body: { 'providers' => providers })))
    client
  end

  before { Rails.cache.delete(described_class::CACHE_KEY) }

  describe 'what the participant asked for' do
    it 'is used verbatim, without second-guessing' do
      resolved = described_class.call(provider: 'anthropic-direct', requested: 'claude-sonnet-5',
                                      client: client_for([direct]))

      expect(resolved).to(eq('claude-sonnet-5'))
    end

    it 'is used even when the list does not contain it' do
      # Validating a REQUESTED model against the provider's list happens elsewhere. Substituting
      # here would run a different model than the picker showed, which is worse than failing
      # at the provider with an id the participant recognises.
      resolved = described_class.call(provider: 'anthropic-direct', requested: 'claude-mystery-9',
                                      client: client_for([direct]))

      expect(resolved).to(eq('claude-mystery-9'))
    end

    it 'does not consult the harness at all when a model was named' do
      # Stubbed so the double is a SPY. An unstubbed `instance_double` cannot answer
      # `have_received` at all — it raises "not a spy", which reads like a failure of the code.
      client = client_for([direct])

      described_class.call(provider: 'anthropic-direct', requested: 'claude-opus-5', client: client)

      # The common path must not pay for a discovery round trip.
      expect(client).not_to(have_received(:list_models))
    end
  end

  describe 'with no model named' do
    it "falls to the provider's first listed model" do
      resolved = described_class.call(provider: 'anthropic-direct', client: client_for([direct]))

      expect(resolved).to(eq('claude-opus-5'))
    end

    it 'resolves a BEDROCK id for a Bedrock run, not a bare first-party one' do
      resolved = described_class.call(provider: 'anthropic-bedrock',
                                      client: client_for([direct, bedrock]))

      # THE defect this class fixes. `claude-opus-4-8` is rejected on Bedrock, so the old
      # hardcoded default made every unspecified run on a Bedrock host fail at dispatch.
      expect(resolved).to(eq('anthropic.claude-opus-5'))
    end

    it 'prefers ANTHROPIC_MODEL when the provider actually lists it' do
      allow(ENV).to(receive(:fetch).and_call_original)
      allow(ENV).to(receive(:fetch).with('ANTHROPIC_MODEL', nil).and_return('claude-sonnet-5'))

      resolved = described_class.call(provider: 'anthropic-direct', client: client_for([direct]))

      expect(resolved).to(eq('claude-sonnet-5'))
    end

    it 'IGNORES ANTHROPIC_MODEL when the provider does not list it' do
      allow(ENV).to(receive(:fetch).and_call_original)
      allow(ENV).to(receive(:fetch).with('ANTHROPIC_MODEL', nil).and_return('claude-sonnet-5'))

      resolved = described_class.call(provider: 'anthropic-bedrock',
                                      client: client_for([direct, bedrock]))

      # An operator setting this for a first-party login must not have it silently applied to
      # Bedrock, where the bare id is invalid.
      expect(resolved).to(eq('anthropic.claude-opus-5'))
    end
  end

  describe 'when nothing can be resolved' do
    it "raises with the PROVIDER'S OWN remedy" do
      expect do
        described_class.call(provider: 'anthropic-bedrock', client: client_for([bedrock_broken]))
      end.to(raise_error(described_class::Unresolvable, /aws sso login/))
    end

    it 'names an unknown provider rather than guessing' do
      expect do
        described_class.call(provider: 'openai-gpt-9', client: client_for([direct]))
      end.to(raise_error(described_class::Unresolvable, /not offered by the harness/))
    end

    it 'raises when the harness is unreachable, instead of inventing a model' do
      client = instance_double(Harness::Client)
      allow(client).to(receive(:list_models).and_raise(Harness::Client::TransportError))

      # Failing here beats starting a run against a guessed id: the participant gets one clear
      # message instead of a provider error two steps later that does not mention the cause.
      expect do
        described_class.call(provider: 'anthropic-direct', client: client)
      end.to(raise_error(described_class::Unresolvable))
    end
  end

  describe 'caching' do
    it 'fetches the provider list once across calls' do
      # A REAL store for this one example. `config.cache_store = :null_store` in test means
      # `Rails.cache.fetch` always misses, so asserting a call count against the default store
      # would be measuring the store rather than this class.
      allow(Rails).to(receive(:cache).and_return(ActiveSupport::Cache::MemoryStore.new))
      client = client_for([direct])

      described_class.call(provider: 'anthropic-direct', client: client)
      described_class.call(provider: 'anthropic-direct', client: client)

      expect(client).to(have_received(:list_models).once)
    end

    it 'shares ModelsController\'s cache key, so the picker and run start agree' do
      # Two independently-timed fetches can disagree for a minute, which would let the picker
      # offer a model that run start then refuses.
      expect(described_class::CACHE_KEY).to(eq(ModelsController::CACHE_KEY))
    end
  end
end
