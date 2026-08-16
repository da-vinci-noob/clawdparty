# frozen_string_literal: true

class AddProviderAndCursorToAiRuns < ActiveRecord::Migration[8.1]
  def change
    change_table(:ai_runs, bulk: true) do |t|
      # Which adapter served the run. Defaulted rather than nullable: Rails chooses the
      # provider at start (Runs::Start::DEFAULT_PROVIDER), so "unknown" is not a state a
      # run can legitimately be in.
      t.string(:provider, null: false, default: 'anthropic-direct')

      # A source IDENTITY (CredentialSourceId), never a value — that is the point of the
      # column: it answers "which login did this run use?" without a credential entering
      # the record. Nullable because it arrives with `request_header`, after the run row.
      t.string(:credential_source)

      # The reconciliation cursor: how far Rails' projection has consumed the harness
      # record for this run. Nullable until the first event lands.
      t.bigint(:harness_store_seq)
    end
  end
end
