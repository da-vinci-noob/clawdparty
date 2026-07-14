# frozen_string_literal: true

# == Schema Information
#
# Table name: tasks
# Database name: primary
#
#  id         :bigint           not null, primary key
#  position   :integer
#  status     :string           default("todo"), not null
#  title      :string           not null
#  created_at :datetime         not null
#  updated_at :datetime         not null
#  owner_id   :bigint
#  session_id :bigint           not null
#
# Indexes
#
#  index_tasks_on_owner_id    (owner_id)
#  index_tasks_on_session_id  (session_id)
#
# Foreign Keys
#
#  fk_rails_...  (owner_id => participants.id)
#  fk_rails_...  (session_id => sessions.id)
#
class Task < ApplicationRecord
  STATUSES = %w[todo doing review done blocked].freeze

  belongs_to :session
  belongs_to :owner, class_name: 'Participant', optional: true

  enum :status, STATUSES.index_with(&:itself), default: 'todo', validate: true

  validates :title, presence: true
end
