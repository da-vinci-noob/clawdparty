# frozen_string_literal: true

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
FactoryBot.define do
  factory :invite do
    session
    role { 'editor' }
    sequence(:token_digest) { |n| Digest::SHA256.hexdigest("token-#{n}") }

    trait :revoked do
      revoked_at { Time.current }
    end

    trait :expired do
      expires_at { 1.hour.ago }
    end
  end
end
