# frozen_string_literal: true

# == Schema Information
#
# Table name: participants
# Database name: primary
#
#  id           :bigint           not null, primary key
#  last_seen_at :datetime
#  role         :string           not null
#  created_at   :datetime         not null
#  updated_at   :datetime         not null
#  session_id   :bigint           not null
#  user_id      :bigint           not null
#
# Indexes
#
#  index_participants_on_session_id  (session_id)
#  index_participants_on_user_id     (user_id)
#
# Foreign Keys
#
#  fk_rails_...  (session_id => sessions.id)
#  fk_rails_...  (user_id => users.id)
#
FactoryBot.define do
  factory :participant do
    session
    user
    role { 'editor' }
  end
end
