# frozen_string_literal: true

require 'rails_helper'

# review is a SHARED-ROOM capability, not an owner privilege.
#
# Asserted against SessionPolicy::MATRIX directly rather than through a controller.
# A request spec proves one endpoint behaves today; this proves the RULE, so a later
# change that narrows review back to owner-only fails here instead of silently
# shipping. That narrowing is the specific regression worth guarding: it is the
# intuitive-looking change ("approval should be the owner's call") and it quietly
# removes the reason a reviewer joins the room at all.
RSpec.describe('review roles', type: :model) do
  let(:session) { create(:session) }

  def policy_for(role)
    SessionPolicy.new(participant: create(:participant, session: session, role: role), session: session)
  end

  describe 'approve / reject' do
    %w[owner editor reviewer].each do |role|
      it "permits #{role} to approve and reject" do
        policy = policy_for(role)

        expect(policy.can?(:approve)).to(be(true))
        expect(policy.can?(:reject)).to(be(true))
      end
    end

    it 'refuses a viewer' do
      policy = policy_for('viewer')

      expect(policy.can?(:approve)).to(be(false))
      expect(policy.can?(:reject)).to(be(false))
    end

    it 'refuses a non-participant entirely' do
      policy = SessionPolicy.new(participant: nil, session: session)

      expect(policy.can?(:approve)).to(be(false))
      expect(policy.can?(:reject)).to(be(false))
    end

    it 'raises NotAuthorized for a viewer rather than returning false silently' do
      expect { policy_for('viewer').authorize!(:approve) }
        .to(raise_error(SessionPolicy::NotAuthorized, /viewer/))
    end
  end

  # The matrix asserted as data, so a role gaining or losing a capability is a
  # visible diff here rather than an emergent behaviour change somewhere else.
  describe 'the matrix itself' do
    it 'grants review to exactly three roles' do
      reviewers = SessionPolicy::MATRIX.select { |_role, actions| actions.include?(:approve) }.keys

      expect(reviewers).to(contain_exactly('owner', 'editor', 'reviewer'))
    end

    it 'keeps approve and reject together — no role may approve but not reject' do
      SessionPolicy::MATRIX.each do |role, actions|
        expect(actions.include?(:approve)).to(eq(actions.include?(:reject)), "#{role} splits approve/reject")
      end
    end

    it 'keeps driving Claude separate from reviewing it' do
      # A reviewer reviews; they do not start or interrupt runs. Collapsing the two
      # would make "can look at the diff" imply "can spend money".
      expect(SessionPolicy::MATRIX.fetch('reviewer')).not_to(include(:run, :interrupt))
      expect(SessionPolicy::MATRIX.fetch('editor')).to(include(:run, :interrupt))
    end

    it 'gives every role chat and view — the room is shared' do
      SessionPolicy::MATRIX.each_value do |actions|
        expect(actions).to(include(:view, :chat))
      end
    end

    it 'reserves invites, archive and session management to the owner' do
      %i[manage_invites manage_session archive].each do |action|
        holders = SessionPolicy::MATRIX.select { |_r, a| a.include?(action) }.keys
        expect(holders).to(eq(['owner']), "#{action} escaped owner-only")
      end
    end

    it 'declares no capability that nothing enforces' do
      # A matrix row nothing checks reads as a live privilege and invites someone to
      # wire it up again. bypass_permissions was exactly that after permission_mode
      # went away.
      #
      # The policy file itself is EXCLUDED from the search: it defines the matrix, so
      # including it makes every action match its own declaration and the assertion
      # proves nothing.
      callers = Rails.root.glob('app/**/*.rb')
                     .reject { |path| path.basename.to_s == 'session_policy.rb' }
                     .sum('', &:read)

      SessionPolicy::MATRIX.values.flatten.uniq.each do |action|
        expect(callers).to(include(action.to_s), "#{action} is in the matrix but no code checks it")
      end
    end
  end
end
