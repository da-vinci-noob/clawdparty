# frozen_string_literal: true

module Events
  # Rebuild a session's `events` rows from the harness's record.
  #
  # `events` is a PROJECTION. The harness's store is the record, so any gap here — a Rails
  # outage, a ring-buffer overflow the harness reported as genuine loss — is repairable by
  # replaying rather than lost. This is the concrete payoff of the store owning the log.
  #
  # Two modes, and the difference is what happens to rows that already exist:
  #
  #   gap-fill (default)  Replay from `max(store_seq) + 1`. Overlap is harmless because
  #                       ingest dedupes on `(ai_run_id, seq)`, so an imprecise cursor
  #                       costs work and never correctness. Broadcasts, since the events
  #                       are genuinely unseen.
  #   reset               Delete the rows the RECORD can rebuild and replay the whole log.
  #                       Does NOT broadcast: the rebuilt rows get NEW ids, so
  #                       re-broadcasting would defeat the client's dedupe-by-id and replay
  #                       the entire session into every open feed.
  #
  # Replays through `Events::Ingest`, never a private insert path — the projection must be
  # built by exactly one code path or "identical to live ingest" is untestable.
  class Rederive
    Result = Struct.new(:accepted, :skipped, :rejected, :from_store_seq, :high_water,
                        keyword_init: true) do
      def total = accepted + skipped + rejected
    end

    BATCH_LIMIT = 5_000

    def self.call(session:, reset: false, client: Harness::Client.new)
      new(session: session, reset: reset, client: client).call
    end

    def initialize(session:, reset: false, client: Harness::Client.new)
      @session = session
      @reset = reset
      @client = client
    end

    def call
      from = reset? ? 0 : (Event.where(session: session).maximum(:store_seq) || 0)
      # FETCH BEFORE MUTATING. Deleting first left a failed fetch with an empty projection
      # and the record intact — recoverable, but a worse state than it started in, and the
      # operator ran this to make things better.
      entries = fetch(from)

      counts = reset? ? rebuild(entries) : replay(entries, broadcast: true)

      Result.new(**counts, from_store_seq: from, high_water: high_water(entries, from))
    end

    private

    attr_reader :session, :client

    def reset? = @reset

    # Delete and rebuild atomically, so a failure part-way through does not leave a session
    # with half a projection and no record of which half.
    #
    # Scoped to rows that CAME FROM the record. Rails appends `chat_message`,
    # `changeset_approved`/`rejected` and `participant_joined` itself, and the harness has no
    # entry for any of them — an unscoped delete destroyed the chat and the review decisions
    # permanently, in the one operation an operator runs to repair a session. A `store_seq` is
    # exactly the marker of a row the record can put back.
    #
    # Preserved rows keep their old (lower) ids while rebuilt rows get new ones, so a
    # mid-session chat message sorts before the transcript in an id-ordered feed. `ts` stays
    # correct and a reset already forces a client reload; losing the message did not.
    def rebuild(entries)
      Event.transaction do
        Event.where(session: session).where.not(store_seq: nil).delete_all
        replay(entries, broadcast: false)
      end
    end

    # Gap-fill is deliberately NOT transactional, so it behaves exactly like live ingest:
    # each event is committed and broadcast on its own, and a subscriber that reacts to a
    # broadcast can always read the row behind it.
    def replay(entries, broadcast:)
      counts = { accepted: 0, skipped: 0, rejected: 0 }
      entries.each do |entry|
        result = broadcast ? Ingest.call(envelope_for(entry)) : Ingest.replay(envelope_for(entry))
        counts[status_of(result)] += 1
      end
      counts
    end

    def fetch(after)
      response = client.list_entries(session.id, after: after)
      raise(Harness::Client::TransportError, "harness returned #{response.status}") unless response.status == 200

      Array(response.body['entries'] || response.body[:entries]).first(BATCH_LIMIT)
    end

    # A store-only entry must never reach here — the harness withholds them. If one
    # does, the projection is the wrong place to discover it, so refuse loudly rather than
    # writing a phantom event that renders as nothing.
    def envelope_for(entry)
      entry = entry.with_indifferent_access
      raise(ArgumentError, "store-only entry #{entry[:store_seq]} reached re-derivation") if store_only?(entry)

      {
        session_id: session.id,
        ai_run_id: entry[:run_id],
        seq: entry[:seq],
        store_seq: entry[:store_seq],
        type: entry[:type],
        actor: actor_for(entry),
        ts: Event.iso_ms(ms_to_time(entry[:ts_ms])),
        payload: entry[:payload] || {}
      }
    end

    # An ABSENT `emitted` means emitted, matching the column's DEFAULT 1 — `.to_i.zero?`
    # alone would read a missing key as store-only and refuse a legitimate entry.
    def store_only?(entry)
      entry.key?(:emitted) && entry[:emitted].to_i.zero?
    end

    # Rational, not `millis / 1000.0`. A float cannot hold 1_700_000_000_001 ms exactly — it
    # lands just below, and formatting to millisecond precision then truncates DOWN, so a
    # replayed event arrives one millisecond earlier than it happened. Under `(run_id, seq)`
    # ordering that is invisible; in a feed sorted by time it silently reorders events.
    def ms_to_time(millis)
      Time.zone.at(Rational(millis.to_i, 1000))
    end

    def actor_for(entry)
      kind = entry[:actor_kind]
      kind == 'user' ? { kind: kind, id: entry[:actor_id] } : { kind: kind }
    end

    def status_of(result)
      return :accepted if result.accepted?
      return :skipped if result.skipped? || result.broadcast?

      :rejected
    end

    def high_water(entries, from)
      entries.filter_map { |e| e.with_indifferent_access[:store_seq] }.max || from
    end
  end
end
