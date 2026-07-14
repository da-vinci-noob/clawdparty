# frozen_string_literal: true

class CreateEnumTypes < ActiveRecord::Migration[8.1]
  def change
    # Native PG enums — used ONLY for the two enums referenced by a DB index/check
    # predicate, so the predicates compare against the stored string values
    # directly (an integer-backed enum would never match `WHERE status IN (...)`).
    create_enum(:ai_run_status, %w[
                  queued running awaiting_review approved rejected
                  superseded completed_clean failed interrupted
                ])
    create_enum(:event_actor_kind, %w[claude user system])
  end
end
