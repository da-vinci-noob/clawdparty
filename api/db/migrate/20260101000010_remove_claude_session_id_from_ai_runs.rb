# frozen_string_literal: true

class RemoveClaudeSessionIdFromAiRuns < ActiveRecord::Migration[8.1]
  # The carrier of the old resume rule. Resumption is now by harness session + lane
  # (Runs::Start#resume_context?), so nothing has written this since the engine swap and
  # `.presence` guaranteed it stayed NULL forever.
  def change
    remove_column(:ai_runs, :claude_session_id, :string)
  end
end
