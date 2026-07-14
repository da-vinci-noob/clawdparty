# frozen_string_literal: true

class CreateAiRuns < ActiveRecord::Migration[8.1]
  def change
    create_table(:ai_runs) do |t|
      t.references(:session, null: false, foreign_key: true)

      # Native PG enum so the partial-unique active-run index predicate
      # `WHERE status IN ('queued','running','awaiting_review')` matches the
      # stored string value directly.
      t.enum(:status, enum_type: :ai_run_status, null: false, default: 'queued')

      # Structural always-present columns.
      t.text(:prompt, null: false)
      t.string(:model, null: false)

      # Attribution: the participant who started the run.
      t.references(:requested_by, foreign_key: { to_table: :participants })

      # W2-only run-orchestration columns — nullable so the W1 replay/seed path
      # can create runs without populating data that does not exist yet.
      t.string(:claude_session_id)
      t.string(:base_sha)
      t.references(:reviewed_by, foreign_key: { to_table: :participants })
      t.decimal(:total_cost_usd, precision: 12, scale: 6)
      t.jsonb(:usage)
      t.jsonb(:diff_stats)

      t.timestamps
    end

    # ONE active run per session, enforced at the DB (not in Ruby).
    add_index(:ai_runs, :session_id,
              unique: true,
              where: "status IN ('queued', 'running', 'awaiting_review')",
              name: 'index_ai_runs_one_active_per_session')
  end
end
