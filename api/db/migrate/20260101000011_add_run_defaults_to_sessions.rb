# frozen_string_literal: true

class AddRunDefaultsToSessions < ActiveRecord::Migration[8.1]
  # What a run starts with when the composer is left alone. All nullable, and NULL is
  # meaningful: "no default set, resolve one at run start" — which is exactly today's behaviour, so
  # every existing session keeps working without a backfill.
  #
  # `aws_profile` is here because it decides WHOSE ACCOUNT PAYS. The harness has accepted a
  # per-run `aws_profile` for some time and nothing ever sent one, so the choice was unreachable from
  # the app and every Bedrock run silently used the harness's env default.
  def change
    # bulk: one ALTER instead of three — Rails/BulkChangeTable, and it matters on a table that is
    # read on every session view.
    change_table(:sessions, bulk: true) do |t|
      t.string(:default_provider)
      t.string(:default_model)
      t.string(:aws_profile)
    end
  end
end
