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
  # Removal is a REVOCATION: the row stays as the referent for the history it is attached to
  # — `events.actor_participant_id` has a foreign key, so a hard delete is refused by the database —
  # and `removed_at` is what withdraws access.
  #
  # `active` is the scope every participantship check must use. A check that forgets it grants a
  # removed participant everything they had, which is the whole failure this guards.
  scope :active, -> { where(removed_at: nil) }

  def removed?
    removed_at.present?
  end

  ROLES = %w[owner editor reviewer viewer].freeze

  belongs_to :session
  belongs_to :user

  has_many :authored_messages, class_name: 'Message', foreign_key: :author_id, inverse_of: :author,
                               dependent: :nullify

  enum :role, ROLES.index_with(&:itself), validate: true

  validates :role, presence: true
end
