# frozen_string_literal: true

# == Schema Information
#
# Table name: messages
# Database name: primary
#
#  id         :bigint           not null, primary key
#  body       :text
#  kind       :string           default("user"), not null
#  created_at :datetime         not null
#  updated_at :datetime         not null
#  author_id  :bigint
#  session_id :bigint           not null
#
# Indexes
#
#  index_messages_on_author_id   (author_id)
#  index_messages_on_session_id  (session_id)
#
# Foreign Keys
#
#  fk_rails_...  (author_id => participants.id)
#  fk_rails_...  (session_id => sessions.id)
#
class Message < ApplicationRecord
  KINDS = %w[user claude system].freeze

  belongs_to :session
  belongs_to :author, class_name: 'Participant', optional: true

  enum :kind, KINDS.index_with(&:itself), default: 'user', validate: true

  # Append-only: no updates or destroys in normal operation.
  def readonly?
    !new_record?
  end
end
