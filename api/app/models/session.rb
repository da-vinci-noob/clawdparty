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
class Session < ApplicationRecord
  STATUSES = %w[active archived].freeze

  belongs_to :host, class_name: 'User', optional: true

  has_many :invites, dependent: :destroy
  has_many :participants, dependent: :destroy
  has_many :users, through: :participants
  has_many :tasks, dependent: :destroy
  has_many :ai_runs, dependent: :destroy
  has_many :messages, dependent: :destroy
  has_many :events, dependent: :destroy

  enum :status, STATUSES.index_with(&:itself), default: 'active', validate: true

  validates :title, presence: true
end
