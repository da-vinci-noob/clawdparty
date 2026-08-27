# frozen_string_literal: true

class AddRemovedAtToParticipants < ActiveRecord::Migration[8.1]
  # Removal is a REVOCATION, not a delete — and the database is what settled that.
  #
  # A hard `destroy` raises `PG::ForeignKeyViolation` on `events.actor_participant_id`, because the
  # event stream is append-only and every message they sent references them. That constraint is
  # right: erasing the row would leave a feed with unattributable messages and an `ai_runs` row
  # claiming a changeset was approved by nobody.
  #
  # So `removed_at` revokes future access while the row stays as the referent for history. NULL means
  # active, which is every existing participant — no backfill.
  def change
    add_column(:participants, :removed_at, :datetime)
    # Partial: the queries that matter ask for ACTIVE participants, and indexing the removed ones
    # would grow the index for rows nothing looks up by this column.
    add_index(:participants, %i[session_id user_id], where: 'removed_at IS NULL',
                                                     name: :index_participants_active_by_user)
  end
end
