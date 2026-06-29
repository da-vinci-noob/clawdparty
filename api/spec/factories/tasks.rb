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
FactoryBot.define do
  factory :task do
    session
    sequence(:title) { |n| "Task #{n}" }
    status { 'todo' }
  end
end
