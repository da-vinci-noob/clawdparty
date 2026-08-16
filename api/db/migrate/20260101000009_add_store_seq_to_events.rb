# frozen_string_literal: true

class AddStoreSeqToEvents < ActiveRecord::Migration[8.1]
  def change
    # `events` is a PROJECTION of the harness record; `store_seq` is the position in
    # that record each row was projected from, so losing Postgres is recoverable by
    # replaying from the highest seq already projected.
    #
    # Nullable, and legitimately so for two kinds of row: events Rails originates
    # itself (chat, participants, changesets — they have no position in the harness
    # record) and ephemeral events (never persisted at all).
    add_column(:events, :store_seq, :bigint)

    # The re-derivation query is "where did this session's projection stop?", so the
    # session leads the index.
    add_index(:events, %i[session_id store_seq])
  end
end
