# frozen_string_literal: true

class AddLaneToAiRuns < ActiveRecord::Migration[8.1]
  # One active run per LANE, replacing one active run per SESSION.
  #
  # `lane` is NOT NULL with a default of 'main', so every existing run is already in the lane it was
  # implicitly in and no backfill is needed. The harness has enforced one-active-run per (session,
  # lane) since M0 and Rails enforced it per session, which meant the DB was the stricter of the two
  # — lifting it here is what lets a second lane exist at all.
  #
  # The partial index is REPLACED rather than added alongside: keeping the per-session one would
  # re-impose exactly the constraint being lifted.
  #
  # The status literals stay QUOTED and cast (`'queued'::ai_run_status`). `status` is a native PG
  # enum, so an unquoted or integer-style literal does not compare — and a partial index whose
  # predicate never matches is a unique constraint that silently enforces nothing.
  def up
    add_column(:ai_runs, :lane, :string, null: false, default: 'main')

    remove_index(:ai_runs, name: :index_ai_runs_one_active_per_session)
    add_index(
      :ai_runs,
      %i[session_id lane],
      unique: true,
      name: :index_ai_runs_one_active_per_lane,
      where: "(status = ANY (ARRAY['queued'::ai_run_status, 'running'::ai_run_status, " \
             "'awaiting_review'::ai_run_status]))"
    )
  end

  def down
    remove_index(:ai_runs, name: :index_ai_runs_one_active_per_lane)
    # Reversing is only safe while every session has at most one active run across all lanes; with
    # two concurrent lanes live, this index cannot be created and the rollback will fail loudly
    # rather than dropping one of them.
    add_index(
      :ai_runs,
      :session_id,
      unique: true,
      name: :index_ai_runs_one_active_per_session,
      where: "(status = ANY (ARRAY['queued'::ai_run_status, 'running'::ai_run_status, " \
             "'awaiting_review'::ai_run_status]))"
    )
    remove_column(:ai_runs, :lane)
  end
end
