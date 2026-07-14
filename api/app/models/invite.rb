# frozen_string_literal: true

require 'digest'
require 'securerandom'

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
class Invite < ApplicationRecord
  ROLES = %w[owner editor reviewer viewer].freeze

  belongs_to :session

  enum :role, ROLES.index_with(&:itself), validate: true

  validates :token_digest, presence: true, uniqueness: true

  # Generate an invite, returning [invite, raw_token]. The raw token is drawn
  # from a CSPRNG with >= 32 bytes of entropy and is only derivable here — the
  # DB stores its SHA-256 digest, never the raw token.
  def self.generate!(session:, role:, expires_at: nil)
    raw = SecureRandom.urlsafe_base64(32)
    invite = create!(
      session: session,
      role: role,
      token_digest: digest_for(raw),
      expires_at: expires_at
    )
    [invite, raw]
  end

  def self.digest_for(raw_token)
    Digest::SHA256.hexdigest(raw_token)
  end

  def revoked?
    revoked_at.present?
  end

  def expired?
    expires_at.present? && expires_at <= Time.current
  end

  def usable?
    !revoked? && !expired?
  end

  def revoke!
    update!(revoked_at: Time.current)
  end
end
