# frozen_string_literal: true

require 'rails_helper'

# a gap in the projection is repairable, because the harness holds the
# record and `events` is only a view of it.
#
# The two modes differ in what happens to rows that already exist, and the broadcast rule
# follows from that: gap-filling ships genuinely-unseen events to the room, while a reset
# rebuild assigns NEW ids and must not, or the client's dedupe-by-id cannot recognise them
# and the whole session replays into every open feed.
RSpec.describe(Events::Rederive) do
  let(:session) { create(:session) }
  let(:ai_run) { create(:ai_run, session: session) }

  def entry(store_seq:, seq:, type: 'ai_text', emitted: 1)
    { 'store_seq' => store_seq, 'run_id' => ai_run.id, 'seq' => seq, 'type' => type,
      'actor_kind' => 'claude', 'actor_id' => nil, 'ts_ms' => 1_700_000_000_000 + store_seq,
      'payload' => { 'text' => "chunk #{seq}" }, 'blocks' => nil, 'on_surface' => 0,
      'emitted' => emitted }
  end

  def stub_harness(rows, expect_after: nil)
    client = instance_double(Harness::Client)
    result = Harness::Client::Result.new(status: 200, body: { 'entries' => rows })
    if expect_after.nil?
      allow(client).to(receive(:list_entries).and_return(result))
    else
      allow(client).to(receive(:list_entries).with(session.id, after: expect_after).and_return(result))
    end
    client
  end

  describe 'gap-fill (the default)' do
    it 'asks the harness for entries AFTER the highest store_seq it already has' do
      described_class.call(session: session, reset: true,
                           client: stub_harness([entry(store_seq: 1, seq: 1)]))

      client = stub_harness([entry(store_seq: 2, seq: 2)], expect_after: 1)
      result = described_class.call(session: session, client: client)

      # Re-fetching the whole log would work — dedupe would absorb it — but on a long
      # session it is the difference between a repair and a stall.
      expect(result.from_store_seq).to(eq(1))
      expect(result.accepted).to(eq(1))
    end

    it 'fills a hole left by an outage without disturbing what survived' do
      client = stub_harness([entry(store_seq: 1, seq: 1), entry(store_seq: 2, seq: 2),
                             entry(store_seq: 3, seq: 3)])
      described_class.call(session: session, reset: true, client: client)
      surviving_id = Event.where(session: session, store_seq: 1).pick(:id)
      Event.where(session: session, store_seq: [2, 3]).delete_all

      described_class.call(session: session, client: client)

      expect(Event.where(session: session).order(:store_seq).pluck(:store_seq)).to(eq([1, 2, 3]))
      # The row that survived keeps its id, so a connected client's cursor stays valid.
      expect(Event.where(session: session, store_seq: 1).pick(:id)).to(eq(surviving_id))
    end

    it 'is idempotent — replaying the same range twice changes nothing' do
      client = stub_harness([entry(store_seq: 1, seq: 1), entry(store_seq: 2, seq: 2)])
      described_class.call(session: session, reset: true, client: client)

      second = nil
      expect { second = described_class.call(session: session, client: client) }
        .not_to(change(Event, :count))
      # Skipped, not rejected: a duplicate `(ai_run_id, seq)` is the dedupe working.
      expect(second.skipped).to(eq(2))
    end

    it 'BROADCASTS, because a gap-filled event is one nobody has seen' do
      client = stub_harness([entry(store_seq: 1, seq: 1)])

      expect { described_class.call(session: session, client: client) }
        .to(have_broadcasted_to(session).from_channel(SessionChannel).at_least(:once))
    end
  end

  describe 'reset' do
    it 'deletes the session rows and rebuilds the whole log' do
      client = stub_harness([entry(store_seq: 1, seq: 1), entry(store_seq: 2, seq: 2)])
      described_class.call(session: session, reset: true, client: client)
      before_ids = Event.where(session: session).pluck(:id)

      described_class.call(session: session, reset: true, client: client)

      expect(Event.where(session: session).count).to(eq(2))
      expect(Event.where(session: session).pluck(:id)).not_to(eq(before_ids))
    end

    it 'does NOT broadcast, because the rebuilt rows have new ids' do
      client = stub_harness([entry(store_seq: 1, seq: 1)])

      # The client dedupes durable events by `event.id`. New ids after a rebuild look like
      # new events, so re-broadcasting would replay the session into every open feed —
      # a participant-visible difference, which  forbids.
      expect { described_class.call(session: session, reset: true, client: client) }
        .not_to(have_broadcasted_to(session).from_channel(SessionChannel))
    end

    # Found running scenario S4.3 against the live stack: a session with 6 events came back
    # from `rederive(reset: true)` with 5. The missing one was `participant_joined`, and the
    # reason generalises — Rails appends `chat_message`, `changeset_approved`/`rejected` and
    # `participant_joined` itself, so no harness entry exists to rebuild them from. Deleting
    # every row and replaying only the record therefore destroys the chat and the review
    # decisions, permanently, in the one operation an operator reaches for to REPAIR a session.
    context 'when the session holds events Rails appended, which the record cannot rebuild' do
      def rails_origin(type, payload = {})
        create(:event, session: session, ai_run: nil, seq: nil, store_seq: nil,
                       event_type: type, actor_kind: 'system', payload: payload)
      end

      it 'keeps the chat, which lives nowhere else' do
        chat = rails_origin('chat_message', { 'text' => 'ship it' })

        described_class.call(session: session, reset: true,
                             client: stub_harness([entry(store_seq: 1, seq: 1)]))

        expect(Event.exists?(chat.id)).to(be(true))
      end

      it 'keeps the review decisions, which are the audit trail for a commit' do
        approved = rails_origin('changeset_approved', { 'commit_sha' => 'abc123' })
        rejected = rails_origin('changeset_rejected')

        described_class.call(session: session, reset: true,
                             client: stub_harness([entry(store_seq: 1, seq: 1)]))

        expect(Event.where(id: [approved.id, rejected.id]).count).to(eq(2))
      end

      it 'still rebuilds everything the record DOES hold' do
        rails_origin('chat_message', { 'text' => 'ship it' })
        described_class.call(session: session, reset: true,
                             client: stub_harness([entry(store_seq: 1, seq: 1)]))
        harness_ids = Event.where(session: session).where.not(store_seq: nil).pluck(:id)

        described_class.call(session: session, reset: true,
                             client: stub_harness([entry(store_seq: 1, seq: 1)]))

        rebuilt = Event.where(session: session).where.not(store_seq: nil)
        expect(rebuilt.count).to(eq(1))
        expect(rebuilt.pluck(:id)).not_to(eq(harness_ids))
      end

      it 'counts only what it replayed, not what it preserved' do
        rails_origin('chat_message', { 'text' => 'ship it' })

        result = described_class.call(session: session, reset: true,
                                      client: stub_harness([entry(store_seq: 1, seq: 1)]))

        expect(result.accepted).to(eq(1))
        expect(result.total).to(eq(1))
      end

      # The cost of preserving them, asserted so it cannot change silently. Rebuilt rows get
      # NEW ids while preserved rows keep their old ones, so a chat message sent mid-session
      # sorts before the whole transcript in a feed ordered by id. `ts` stays correct, and the
      # client reloads after a reset anyway — but losing the message outright was worse, and
      # this is the trade that was made.
      it 'leaves preserved rows with LOWER ids than everything rebuilt' do
        chat = rails_origin('chat_message', { 'text' => 'sent late' })

        described_class.call(session: session, reset: true,
                             client: stub_harness([entry(store_seq: 1, seq: 1)]))

        rebuilt = Event.where(session: session).where.not(store_seq: nil).pluck(:id)
        expect(rebuilt.min).to(be > chat.id)
      end
    end

    it 'leaves OTHER sessions untouched' do
      other = create(:session)
      other_run = create(:ai_run, session: other)
      create(:event, session: other, ai_run: other_run, seq: 1, store_seq: 1)

      described_class.call(session: session, reset: true,
                           client: stub_harness([entry(store_seq: 1, seq: 1)]))

      expect(Event.where(session: other).count).to(eq(1))
    end
  end

  describe 'it refuses what it cannot faithfully project' do
    it 'raises on a store-only entry rather than writing a phantom event' do
      client = stub_harness([entry(store_seq: 1, seq: nil, emitted: 0)])

      # The harness withholds these. One arriving means that filter broke, and a
      # phantom event renders as nothing — so the projection would be silently wrong.
      expect { described_class.call(session: session, client: client) }
        .to(raise_error(ArgumentError, /store-only/))
    end

    it 'raises when the harness cannot serve the record' do
      client = instance_double(Harness::Client)
      allow(client).to(receive(:list_entries)
        .and_return(Harness::Client::Result.new(status: 409, body: { 'error' => 'store_unavailable' })))

      # A locked or missing store is a state to retry, not an empty record — treating it as
      # empty would report a successful re-derivation that projected nothing.
      expect { described_class.call(session: session, client: client) }
        .to(raise_error(Harness::Client::TransportError, /409/))
    end

    it 'does not delete anything when the fetch fails' do
      client = instance_double(Harness::Client)
      allow(client).to(receive(:list_entries)
        .and_return(Harness::Client::Result.new(status: 500, body: {})))
      create(:event, session: session, ai_run: ai_run, seq: 1, store_seq: 1)

      # reset: true deletes BEFORE fetching, so a failed fetch would leave the projection
      # empty with the record intact — repairable, but a worse state than it started in.
      expect { described_class.call(session: session, reset: true, client: client) }
        .to(raise_error(Harness::Client::TransportError))
      expect(Event.where(session: session).count).to(eq(1))
    end
  end
end
