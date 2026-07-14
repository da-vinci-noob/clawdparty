# frozen_string_literal: true

class AddModeToSessions < ActiveRecord::Migration[8.1]
  def change
    # Session run mode: 'review' (git-backed worktree + diff + approve/reject, the
    # default) or 'chat' (run Claude live in a plain working directory, no worktree
    # / diff / approval). String-backed (like `status`), not integer.
    add_column(:sessions, :mode, :string, null: false, default: 'review')
  end
end
