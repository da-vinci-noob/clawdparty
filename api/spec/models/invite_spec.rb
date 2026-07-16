# frozen_string_literal: true

require 'rails_helper'

# == Schema Information
#
# Table name: invites
# Database name: primary
#
#  id           :bigint           not null, primary key
#  expires_at   :datetime
#  revoked_at   :datetime
#  role         :string           not null
#  token_digest :string           not null
#  created_at   :datetime         not null
#  updated_at   :datetime         not null
#  session_id   :bigint           not null
#
# Indexes
#
#  index_invites_on_session_id    (session_id)
#  index_invites_on_token_digest  (token_digest) UNIQUE
#
# Foreign Keys
#
#  fk_rails_...  (session_id => sessions.id)
#
RSpec.describe(Invite) do
  describe '#revoked? / #expired? / #usable?' do
    it 'is usable when neither revoked nor expired' do
      invite = create(:invite)
      expect(invite.revoked?).to(be(false))
      expect(invite.expired?).to(be(false))
      expect(invite.usable?).to(be(true))
    end

    it 'is expired (and not usable) once expires_at is in the past' do
      invite = create(:invite, :expired)
      expect(invite.expired?).to(be(true))
      expect(invite.usable?).to(be(false))
    end

    it 'is not expired when expires_at is nil or in the future' do
      expect(create(:invite, expires_at: nil).expired?).to(be(false))
      expect(create(:invite, expires_at: 1.hour.from_now).expired?).to(be(false))
    end

    it 'is revoked (and not usable) once revoked_at is set' do
      invite = create(:invite, :revoked)
      expect(invite.revoked?).to(be(true))
      expect(invite.usable?).to(be(false))
    end
  end

  describe '#revoke!' do
    it 'stamps revoked_at and flips usable? to false' do
      invite = create(:invite)
      expect { invite.revoke! }.to(change(invite, :usable?).from(true).to(false))
      expect(invite.revoked_at).to(be_present)
    end

    it 'is idempotent (a second revoke keeps it revoked)' do
      invite = create(:invite)
      invite.revoke!
      expect { invite.revoke! }.not_to(raise_error)
      expect(invite.reload.revoked?).to(be(true))
    end
  end
end
