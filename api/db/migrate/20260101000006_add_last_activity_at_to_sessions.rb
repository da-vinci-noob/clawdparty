# frozen_string_literal: true

class AddLastActivityAtToSessions < ActiveRecord::Migration[8.1]
  # Denormalized recency signal for the per-user session list (session-history):
  # advanced whenever an event is appended for the session (Events::Append), so the
  # home list can order by real activity rather than created_at. Backfill existing
  # rows to their created_at so ordering is well-defined without a data job; new
  # rows default to the row's created_at via the model.
  def up
    add_column(:sessions, :last_activity_at, :datetime)
    execute('UPDATE sessions SET last_activity_at = created_at WHERE last_activity_at IS NULL')
  end

  def down
    remove_column(:sessions, :last_activity_at)
  end
end
