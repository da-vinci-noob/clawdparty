# frozen_string_literal: true

# == Schema Information
#
# Table name: sessions
# Database name: primary
#
#  id               :bigint           not null, primary key
#  base_branch      :string
#  branch_name      :string
#  last_activity_at :datetime
#  mode             :string           default("review"), not null
#  objective        :text
#  repository_path  :string
#  status           :string           default("active"), not null
#  title            :string           not null
#  worktree_path    :string
#  created_at       :datetime         not null
#  updated_at       :datetime         not null
#  host_id          :bigint
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
  # Run mode. `review` = git-backed (per-session worktree + diff + approve/reject).
  # `chat` = run Claude live in `repository_path` (the session working directory —
  # git repo OR plain dir), with no worktree / diff / approval.
  MODES = %w[review chat].freeze

  belongs_to :host, class_name: 'User', optional: true

  has_many :invites, dependent: :destroy
  has_many :participants, dependent: :destroy
  has_many :users, through: :participants
  has_many :tasks, dependent: :destroy
  has_many :ai_runs, dependent: :destroy
  has_many :messages, dependent: :destroy
  has_many :events, dependent: :destroy

  enum :status, STATUSES.index_with(&:itself), default: 'active', validate: true
  enum :mode, MODES.index_with(&:itself), default: 'review', validate: true

  validates :title, presence: true

  # Seed the recency signal so a session with no events yet still sorts sensibly
  # in the per-user history list (session-history). Events::Append advances it
  # thereafter.
  before_create { self.last_activity_at ||= Time.current }

  # Sessions a user hosts OR participates in, de-duplicated, newest activity first
  # — the backing query for the per-user session list (GET /api/sessions).
  scope :for_user, lambda { |user|
    left_outer_joins(:participants)
      .where('sessions.host_id = :uid OR participants.user_id = :uid', uid: user.id)
      .distinct
      .order(Arel.sql('sessions.last_activity_at DESC NULLS LAST'))
  }
end
