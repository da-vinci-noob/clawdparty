# frozen_string_literal: true

class CreateMessagesAndEvents < ActiveRecord::Migration[8.1]
  def change
    create_table(:messages) do |t|
      t.references(:session, null: false, foreign_key: true)
      t.references(:author, foreign_key: { to_table: :participants })
      t.string(:kind, null: false, default: 'user') # user / claude / system (string-backed)
      t.text(:body)
      t.timestamps
    end

    create_table(:events) do |t|
      t.references(:session, null: false, foreign_key: true)
      t.string(:event_type, null: false)
      t.enum(:actor_kind, enum_type: :event_actor_kind, null: false)
      t.references(:actor_participant, foreign_key: { to_table: :participants })
      t.references(:ai_run, foreign_key: true) # nullable: session-scoped events have no run
      t.bigint(:seq) # nullable: only durable run-scoped events carry a seq
      t.jsonb(:payload, null: false, default: {})

      # `ts` is derived from created_at at serialization time — no separate column.
      t.timestamps
    end

    # Idempotent ingest: (ai_run_id, seq) uniquely identifies a run-scoped event.
    # Postgres treats NULLs as distinct, so session-scoped events (null ai_run_id)
    # never collide here — the index constrains only run-scoped rows.
    add_index(:events, %i[ai_run_id seq], unique: true, name: 'index_events_on_run_and_seq')

    # actor_participant_id is non-null IFF actor_kind = 'user'.
    add_check_constraint(:events,
                         "(actor_kind = 'user') = (actor_participant_id IS NOT NULL)",
                         name: 'events_user_actor_has_participant')
  end
end
