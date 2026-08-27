# frozen_string_literal: true

module Events
  # The single ingestion service for events arriving from the harness or a
  # replay. Classifies ephemeral vs durable, persists durable with DB-level
  # dedupe on (ai_run_id, seq), never persists ephemeral, and BROADCASTS every
  # accepted event — broadcast lives HERE (not in a controller) so a direct
  # in-process caller (the fake-Claude replay) both persists and broadcasts
  # identically to a harness-driven ingest.
  class Ingest
    Result = Struct.new(:status, :event, keyword_init: true) do
      def accepted? = status == :accepted
      def skipped? = status == :skipped
      def broadcast? = status == :broadcast
      def rejected? = status == :rejected
    end

    # `attrs` is a Contract-1 envelope hash (string or symbol keys). `ai_run_id`,
    # `session_id`, and `actor_participant_id`/`actor` are already remapped to
    # real DB ids by the caller (controller or rake).
    def self.call(attrs)
      new(attrs).call
    end

    # Persist WITHOUT broadcasting — for a RESET re-derivation only.
    #
    # Rebuilding a session's rows gives them new ids, so re-broadcasting would defeat the
    # client's dedupe-by-id and replay every old event as new: a participant-visible
    # difference, which  forbids. Gap-filling uses `call`, because those events are
    # genuinely unseen.
    #
    # A separate method rather than `call(attrs, broadcast:)`: callers pass a brace-less
    # hash (`call('session_id' => …)`), and Ruby reads that as keywords the moment the
    # method accepts any — so adding one turns every existing call site into
    # `wrong number of arguments (given 0, expected 1)`.
    def self.replay(attrs)
      new(attrs, broadcast: false).call
    end

    def initialize(attrs, broadcast: true)
      @attrs = attrs.symbolize_keys
      @should_broadcast = broadcast
    end

    def call
      if ephemeral?
        broadcast(ephemeral_envelope)
        return Result.new(status: :broadcast, event: nil)
      end

      persist_and_broadcast
    end

    private

    attr_reader :attrs

    def event_type
      @event_type ||= attrs[:type] || attrs[:event_type]
    end

    def ephemeral?
      Event.ephemeral_type?(event_type)
    end

    def persist_and_broadcast
      event = build_event
      event.save!
      broadcast(event.to_envelope)
      # Rails owns run-state transitions, driven by the event stream (not polling):
      # a run-lifecycle event advances the run via Runs::Finalize.
      Runs::Finalize.call(event)
      Result.new(status: :accepted, event: event)
    rescue ActiveRecord::RecordNotUnique
      # Idempotent: a duplicate (ai_run_id, seq) is silently skipped, never raised.
      Result.new(status: :skipped, event: nil)
    rescue ActiveRecord::RecordInvalid
      # A malformed envelope (e.g. a user actor with no participant) is rejected
      # cleanly — never persisted, never broadcast, never a StatementInvalid 500.
      Result.new(status: :rejected, event: nil)
    end

    def build_event
      actor = (attrs[:actor] || {}).symbolize_keys
      Event.new(
        session_id: attrs[:session_id],
        event_type: event_type,
        actor_kind: actor[:kind] || attrs[:actor_kind],
        actor_participant_id: actor[:id] || attrs[:actor_participant_id],
        ai_run_id: attrs[:ai_run_id],
        seq: attrs[:seq],
        store_seq: attrs[:store_seq],
        payload: attrs[:payload] || {},
        **occurred_at
      )
    end

    # `to_envelope` reads `ts` off `created_at`, so leaving it to the DB default stamps an
    # event with the moment Rails INSERTED it rather than the moment it happened. Live,
    # those differ by milliseconds and it never shows. On re-derivation they differ by
    # however long the outage lasted, and every replayed event would claim to have
    # happened at once. The harness's `ts` is the authoritative time either way.
    def occurred_at
      ts = attrs[:ts]
      return {} if ts.blank?

      { created_at: Time.zone.parse(ts.to_s) }
    rescue ArgumentError
      {}
    end

    # Ephemeral broadcast envelope: id AND seq are null (broadcast-not-persisted,
    # and ephemeral never consumes a per-run seq).
    def ephemeral_envelope
      actor = (attrs[:actor] || {}).symbolize_keys
      {
        id: nil,
        session_id: attrs[:session_id].to_s,
        ai_run_id: attrs[:ai_run_id]&.to_s,
        seq: nil,
        type: event_type,
        actor: actor.presence || { kind: attrs[:actor_kind] },
        ts: Event.iso_ms(Time.current),
        payload: attrs[:payload] || {}
      }
    end

    def broadcast(envelope)
      return unless @should_broadcast

      session = Session.find_by(id: attrs[:session_id])
      return unless session

      SessionChannel.broadcast_to(session, envelope)
    end
  end
end
