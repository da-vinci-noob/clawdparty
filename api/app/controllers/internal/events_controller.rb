# frozen_string_literal: true

module Internal
  # Thin batch-ingest endpoint: auth → parse batch → Events::Ingest.call(each) →
  # render. ZERO ingestion/dedupe/broadcast logic of its own — all of that lives
  # in Events::Ingest, so a direct in-process replay behaves identically.
  class EventsController < BaseController
    REQUIRED_FIELDS = %w[type session_id actor ts].freeze

    def create
      batch = parse_batch
      return if performed? # 422 already rendered

      accepted = 0
      skipped = 0
      batch.each do |event_attrs|
        result = Events::Ingest.call(event_attrs)
        accepted += 1 if result.accepted? || result.broadcast?
        skipped += 1 if result.skipped? || result.rejected?
      end

      render(json: { accepted: accepted, skipped: skipped }, status: :ok)
    end

    private

    # A malformed batch (unparseable, missing `events`, or any element missing a
    # required envelope field) is rejected 422 and ingests nothing — atomic.
    # Null id/ai_run_id/seq are VALID (ephemeral/session-scoped), not malformed.
    def parse_batch
      events = params[:events]
      return render_malformed unless events.is_a?(Array)

      attrs = events.map { |e| permit_event(e) }
      return render_malformed if attrs.any? { |e| malformed?(e) }

      attrs
    end

    def permit_event(event)
      event.permit(:id, :session_id, :ai_run_id, :seq, :type, :event_type, :actor_kind, :ts,
                   actor: %i[kind id], payload: {}).to_h
    end

    def malformed?(event)
      REQUIRED_FIELDS.any? { |f| event[f].nil? || (event[f].respond_to?(:empty?) && event[f].empty?) } ||
        user_actor_missing_participant?(event)
    end

    # A `user` actor MUST carry a participant id; without one the event can never
    # satisfy the DB check, so reject the whole batch up front (atomic 422).
    def user_actor_missing_participant?(event)
      actor = event[:actor]
      actor.is_a?(Hash) && actor[:kind] == 'user' && actor[:id].nil?
    end

    def render_malformed
      render(json: { errors: [{ message: 'Malformed batch' }] }, status: :unprocessable_content)
      nil
    end
  end
end
