# frozen_string_literal: true

module Events
  # The write-side sibling of Events::Ingest. Wraps a state mutation and the
  # insertion of its corresponding event in ONE transaction, so the event stream
  # alone can reconstruct the UI and no mutation commits without its event (or
  # vice versa). The appended event flows through the same broadcast path.
  #
  # Usage:
  #   Events::Append.call(session:, event:) { mutating_block_returning_record }
  class Append
    def self.call(session:, event:, &mutation)
      new(session: session, event: event).call(&mutation)
    end

    def initialize(session:, event:)
      @session = session
      @event_attrs = event.symbolize_keys
    end

    def call
      record = nil
      built = nil
      ActiveRecord::Base.transaction do
        record = yield if block_given?
        built = Event.create!(persist_attrs)
        # Advance the session's recency signal in the same transaction as the
        # event insert, so the per-user history list (session-history) orders by
        # real activity. update_column skips validations/callbacks/updated_at by
        # design — this is a bookkeeping touch, not a domain mutation.
        @session.update_column(:last_activity_at, built.created_at) # rubocop:disable Rails/SkipsModelValidations
      end
      # Broadcast only after the transaction commits successfully.
      SessionChannel.broadcast_to(@session, built.to_envelope)
      record
    end

    private

    def persist_attrs
      actor = (@event_attrs[:actor] || {}).symbolize_keys
      {
        session_id: @session.id,
        event_type: @event_attrs[:type] || @event_attrs[:event_type],
        actor_kind: actor[:kind] || @event_attrs[:actor_kind],
        actor_participant_id: actor[:id] || @event_attrs[:actor_participant_id],
        ai_run_id: @event_attrs[:ai_run_id],
        seq: @event_attrs[:seq],
        payload: @event_attrs[:payload] || {}
      }
    end
  end
end
