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
class Participant < ApplicationRecord
  ROLES = %w[owner editor reviewer viewer].freeze

  belongs_to :session
  belongs_to :user

  has_many :authored_messages, class_name: 'Message', foreign_key: :author_id, inverse_of: :author,
                               dependent: :nullify

  enum :role, ROLES.index_with(&:itself), validate: true

  validates :role, presence: true
end
