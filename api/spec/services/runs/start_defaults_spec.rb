# frozen_string_literal: true

require 'rails_helper'

# The audit check: a default set in Settings is what the next run STARTS with when the composer is
# left alone — and a per-run choice still wins.
#
# The point of writing this as a service spec: a setting nothing reads is the recurring defect of this
# whole phase (`allowed_tools`, `connectors`, `skills`, `disallowed_tools` were all accepted and
# ignored). The only proof that a default is real is the payload the harness receives.
RSpec.describe(Runs::Start) do
  let(:session) do
    create(:session, mode: 'chat', repository_path: '/repo',
                     default_provider: 'anthropic-bedrock',
                     default_model: 'global.anthropic.claude-sonnet-4-6',
                     aws_profile: 'claude-code-sso')
  end
  let(:owner) { create(:participant, session: session, role: 'owner') }
  let(:posted) { [] }
  let(:client) do
    fake = instance_double(Harness::Client)
    allow(fake).to(receive(:start_run)) do |payload|
      posted << payload
      Harness::Client::Result.new(status: 202, body: {})
    end
    fake
  end

  def start(**over)
    described_class.call(session: session, requested_by: owner, prompt: 'go', client: client, **over)
  end

  describe 'when the caller names no model or provider' do
    it 'uses the session defaults' do
      start(model: nil)

      expect(posted.last).to(include(provider: 'anthropic-bedrock',
                                     model: 'global.anthropic.claude-sonnet-4-6'))
    end

    it 'sends the session AWS profile, so the run bills the chosen account' do
      # which profile is used decides WHOSE ACCOUNT PAYS. The harness has accepted this field
      # for some time and nothing ever sent one, so every Bedrock run silently used the env default.
      start(model: nil)
      expect(posted.last).to(include(aws_profile: 'claude-code-sso'))
    end
  end

  describe 'when the caller names one' do
    it 'prefers the explicit provider and model over the defaults' do
      # The composer's per-run pick is the point of having a picker; a default is what it starts on.
      start(model: 'us.deepseek.r1-v1:0', provider: 'bedrock-converse')

      expect(posted.last).to(include(provider: 'bedrock-converse', model: 'us.deepseek.r1-v1:0'))
    end
  end

  describe 'a session with no defaults set' do
    let(:session) { create(:session, mode: 'chat', repository_path: '/repo') }

    it 'keeps the previous behaviour: the built-in provider and whatever the caller passed' do
      start(model: 'claude-opus-4-8')

      expect(posted.last).to(include(provider: described_class::DEFAULT_PROVIDER,
                                     model: 'claude-opus-4-8'))
    end

    it 'omits aws_profile entirely rather than sending nil' do
      # The harness reads an absent key as "use the host default", which is a different request from
      # an explicit null.
      start(model: 'claude-opus-4-8')
      expect(posted.last).not_to(have_key(:aws_profile))
    end
  end
end
