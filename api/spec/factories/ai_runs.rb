# frozen_string_literal: true

# == Schema Information
#
# Table name: ai_runs
# Database name: primary
#
#  id                :bigint           not null, primary key
#  base_sha          :string
#  diff_stats        :jsonb
#  model             :string           not null
#  prompt            :text             not null
#  status            :enum             default("queued"), not null
#  total_cost_usd    :decimal(12, 6)
#  usage             :jsonb
#  created_at        :datetime         not null
#  updated_at        :datetime         not null
#  claude_session_id :string
#  requested_by_id   :bigint
#  reviewed_by_id    :bigint
#  session_id        :bigint           not null
#
# Indexes
#
#  index_ai_runs_on_requested_by_id      (requested_by_id)
#  index_ai_runs_on_reviewed_by_id       (reviewed_by_id)
#  index_ai_runs_on_session_id           (session_id)
#  index_ai_runs_one_active_per_session  (session_id) UNIQUE WHERE (status = ANY (ARRAY['queued'::ai_run_status, 'running'::ai_run_status, 'awaiting_review'::ai_run_status]))
#
# Foreign Keys
#
#  fk_rails_...  (requested_by_id => participants.id)
#  fk_rails_...  (reviewed_by_id => participants.id)
#  fk_rails_...  (session_id => sessions.id)
#
FactoryBot.define do
  factory :ai_run do
    session
    status { 'running' }
    prompt { 'Do the thing.' }
    model { 'claude-opus-4-8' }
  end
end
