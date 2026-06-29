# frozen_string_literal: true

require 'rails_helper'

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
RSpec.describe(AiRun) do
  let(:session) { create(:session) }

  describe 'one-active-run-per-session partial unique index' do
    it 'rejects a second active run for the same session at the DB' do
      create(:ai_run, session: session, status: 'running')

      expect do
        described_class.create!(session: session, status: 'queued', prompt: 'x', model: 'm')
      end.to(raise_error(ActiveRecord::RecordNotUnique))
    end

    it 'allows a new active run once the prior run is in a terminal status' do
      first = create(:ai_run, session: session, status: 'running')
      first.update!(status: 'completed_clean')

      expect do
        create(:ai_run, session: session, status: 'running')
      end.not_to(raise_error)
    end

    %w[approved rejected superseded completed_clean failed interrupted].each do |terminal|
      it "does not count #{terminal} as active" do
        create(:ai_run, session: session, status: terminal)

        expect { create(:ai_run, session: session, status: 'running') }.not_to(raise_error)
      end
    end
  end

  describe 'status enum' do
    it 'stores status as its string value (native PG enum), so the partial index predicate matches' do
      run = create(:ai_run, session: session, status: 'running')
      raw = described_class.connection.select_value(
        described_class.sanitize_sql_array(['SELECT status FROM ai_runs WHERE id = ?', run.id])
      )
      expect(raw).to(eq('running'))
    end

    it 'covers all nine states' do
      expect(described_class::STATUSES.size).to(eq(9))
    end
  end
end
