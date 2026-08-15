# frozen_string_literal: true

class AddLastHeartbeatAtToAiRuns < ActiveRecord::Migration[8.1]
  # Refreshed ONLY for runs the harness names in its heartbeat, so a run the harness
  # has lost stops being refreshed and ages out via Harness::HealthcheckJob.
  def up
    add_column(:ai_runs, :last_heartbeat_at, :datetime)
    add_index(:ai_runs, %i[status last_heartbeat_at])
  end

  def down
    remove_index(:ai_runs, %i[status last_heartbeat_at])
    remove_column(:ai_runs, :last_heartbeat_at)
  end
end
