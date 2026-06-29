# frozen_string_literal: true

require 'rails_helper'

RSpec.describe(SessionPolicy) do
  let(:session) { create(:session) }

  def policy_for(role)
    participant = create(:participant, session: session, role: role)
    described_class.new(participant: participant, session: session)
  end

  describe 'approve/reject is owner-only' do
    it 'permits an owner' do
      expect(policy_for('owner').can?(:approve)).to(be(true))
      expect(policy_for('owner').can?(:reject)).to(be(true))
    end

    %w[editor reviewer viewer].each do |role|
      it "denies a #{role}" do
        expect(policy_for(role).can?(:approve)).to(be(false))
        expect { policy_for(role).authorize!(:reject) }.to(raise_error(described_class::NotAuthorized))
      end
    end
  end

  describe 'run/interrupt is owner+editor' do
    it 'permits owner and editor, denies reviewer and viewer' do
      expect(policy_for('owner').can?(:run)).to(be(true))
      expect(policy_for('editor').can?(:interrupt)).to(be(true))
      expect(policy_for('reviewer').can?(:run)).to(be(false))
      expect(policy_for('viewer').can?(:run)).to(be(false))
    end
  end

  describe 'tasks is owner+editor+reviewer (not viewer)' do
    it 'permits reviewer, denies viewer' do
      expect(policy_for('reviewer').can?(:manage_tasks)).to(be(true))
      expect(policy_for('viewer').can?(:manage_tasks)).to(be(false))
    end
  end

  describe 'view + chat is everyone' do
    %w[owner editor reviewer viewer].each do |role|
      it "permits #{role}" do
        expect(policy_for(role).can?(:view)).to(be(true))
        expect(policy_for(role).can?(:chat)).to(be(true))
      end
    end
  end
end
