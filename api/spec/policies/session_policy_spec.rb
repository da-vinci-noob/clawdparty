# frozen_string_literal: true

require 'rails_helper'

RSpec.describe(SessionPolicy) do
  let(:session) { create(:session) }

  def policy_for(role)
    participant = create(:participant, session: session, role: role)
    described_class.new(participant: participant, session: session)
  end

  describe 'approve/reject is everyone except viewer' do
    %w[owner editor reviewer].each do |role|
      it "permits a #{role}" do
        expect(policy_for(role).can?(:approve)).to(be(true))
        expect(policy_for(role).can?(:reject)).to(be(true))
      end
    end

    it 'denies a viewer' do
      expect(policy_for('viewer').can?(:approve)).to(be(false))
      expect { policy_for('viewer').authorize!(:reject) }.to(raise_error(described_class::NotAuthorized))
    end
  end

  describe 'manage_invites/manage_session is owner-only' do
    it 'permits an owner' do
      expect(policy_for('owner').can?(:manage_invites)).to(be(true))
      expect(policy_for('owner').can?(:manage_session)).to(be(true))
    end

    %w[editor reviewer viewer].each do |role|
      it "denies a #{role}" do
        expect(policy_for(role).can?(:manage_session)).to(be(false))
        expect { policy_for(role).authorize!(:manage_session) }.to(raise_error(described_class::NotAuthorized))
      end
    end
  end

  # bypass_permissions and manage_tasks were REMOVED from the matrix: the first
  # gated the permission_mode parameter, which no longer exists, and the second
  # gated the task board, which was cut from the MVP. Asserted as absences so the
  # matrix cannot regrow a privilege nothing enforces.
  describe 'capabilities the matrix no longer declares' do
    %i[bypass_permissions manage_tasks].each do |action|
      it "grants #{action} to nobody, including an owner" do
        described_class::MATRIX.each_key do |role|
          expect(policy_for(role).can?(action)).to(be(false))
        end
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

  describe 'view + chat is everyone' do
    %w[owner editor reviewer viewer].each do |role|
      it "permits #{role}" do
        expect(policy_for(role).can?(:view)).to(be(true))
        expect(policy_for(role).can?(:chat)).to(be(true))
      end
    end
  end
end
