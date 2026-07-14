# frozen_string_literal: true

# == Schema Information
#
# Table name: sessions
# Database name: primary
#
#  id              :bigint           not null, primary key
#  base_branch     :string
#  branch_name     :string
#  objective       :text
#  repository_path :string
#  status          :string           default("active"), not null
#  title           :string           not null
#  worktree_path   :string
#  created_at      :datetime         not null
#  updated_at      :datetime         not null
#  host_id         :bigint
#
# Indexes
#
#  index_sessions_on_host_id  (host_id)
#
# Foreign Keys
#
#  fk_rails_...  (host_id => users.id)
#
FactoryBot.define do
  factory :session do
    sequence(:title) { |n| "Session #{n}" }
    status { 'active' }
  end
end
