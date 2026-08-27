# frozen_string_literal: true

require 'rails_helper'

# replaying the record rebuilds the projection, and a divergence is
# DETECTED rather than tolerated.
#
# `events` is a projection of the harness's store. The failure worth catching is not a
# projection that is visibly empty — someone notices that — but one that is quietly wrong,
# because then the feed looks complete and every number read off it is false.
#
# The harness is stubbed at `Harness::Client`, which is the seam Rails owns. Driving a real
# harness here would test the HTTP hop rather than the projection logic, and the harness's
# own side is covered by its store and server suites.
RSpec.describe(Events::ProjectionCheck) do
  let(:session) { create(:session) }
  let(:ai_run) { create(:ai_run, session: session) }

  # The record, as the harness would serve it: three events on one run.
  def entries
    [
      entry(store_seq: 1, seq: 1, type: 'run_started', actor_kind: 'system'),
      entry(store_seq: 2, seq: 2, type: 'ai_text', actor_kind: 'claude'),
      entry(store_seq: 3, seq: 3, type: 'run_finished', actor_kind: 'system')
    ]
  end

  def entry(store_seq:, seq:, type:, actor_kind:, payload: { 'text' => 'hi' })
    { 'store_seq' => store_seq, 'run_id' => ai_run.id, 'seq' => seq, 'type' => type,
      'actor_kind' => actor_kind, 'actor_id' => nil, 'ts_ms' => 1_700_000_000_000 + store_seq,
      'payload' => payload, 'blocks' => nil, 'on_surface' => 0, 'emitted' => 1 }
  end

  def stub_harness(rows)
    client = instance_double(Harness::Client)
    allow(client).to(receive(:list_entries).and_return(
                       Harness::Client::Result.new(status: 200, body: { 'entries' => rows })
                     ))
    client
  end

  describe 'a projection built by replay matches one built live' do
    it 'reports no divergence after re-deriving into an empty table' do
      client = stub_harness(entries)
      Events::Rederive.call(session: session, reset: true, client: client)

      expect(described_class.call(session: session, client: client)).to(be_ok)
    end

    it 'produces the same rows the harness recorded, in the same order' do
      client = stub_harness(entries)

      Events::Rederive.call(session: session, reset: true, client: client)

      rows = Event.where(session: session).order(:store_seq)
      expect(rows.pluck(:store_seq, :event_type, :seq)).to(eq([[1, 'run_started', 1],
                                                               [2, 'ai_text', 2],
                                                               [3, 'run_finished', 3]]))
    end

    it 'keeps the time the event HAPPENED, not the time it was replayed' do
      client = stub_harness(entries)

      Events::Rederive.call(session: session, reset: true, client: client)

      # `to_envelope` reads `ts` off `created_at`. Left to the DB default, every replayed
      # event would claim to have happened at the moment of the replay — so a re-derived
      # feed would show an entire session collapsed into one instant.
      stamps = Event.where(session: session).order(:store_seq).map { |e| Event.iso_ms(e.created_at) }
      expect(stamps).to(eq(['2023-11-14T22:13:20.001Z',
                            '2023-11-14T22:13:20.002Z',
                            '2023-11-14T22:13:20.003Z']))
    end
  end

  describe 'an injected divergence is detected' do
    before { Events::Rederive.call(session: session, reset: true, client: stub_harness(entries)) }

    it 'detects a SKIPPED batch' do
      Event.where(session: session, store_seq: 3).delete_all

      result = described_class.call(session: session, client: stub_harness(entries))

      # The common case: Rails was down, or the harness reported ring-buffer loss.
      expect(result).to(be_diverged)
      expect(result.reason).to(eq(:missing_batch))
      expect(result.rails_high_water).to(eq(2))
      expect(result.harness_high_water).to(eq(3))
    end

    it 'detects a MUTATED row, which leaves the high water mark untouched' do
      # update_all deliberately: corruption does not run validations either, and a row
      # rewritten through the model would not reproduce what this detects.
      Event.where(session: session, store_seq: 2).update_all(event_type: 'ai_thinking') # rubocop:disable Rails/SkipsModelValidations

      result = described_class.call(session: session, client: stub_harness(entries))

      # Invisible to a max(store_seq) comparison — this is what the digest is for.
      expect(result).to(be_diverged)
      expect(result.reason).to(eq(:content_mismatch))
      expect(result.rails_high_water).to(eq(result.harness_high_water))
    end

    it 'detects a DUPLICATED batch' do
      # A duplicate under a DIFFERENT run, since (ai_run_id, seq) is unique — which is
      # exactly how a duplicate would survive ingest's dedupe and reach the projection.
      other = create(:ai_run, session: session, status: 'approved')
      Event.create!(session: session, ai_run: other, seq: 1, store_seq: 2,
                    event_type: 'ai_text', actor_kind: 'claude', payload: {})

      result = described_class.call(session: session, client: stub_harness(entries))

      expect(result).to(be_diverged)
      expect(result.reason).to(eq(:content_mismatch))
      expect(result.rails_count).to(be > result.harness_count)
    end

    it 'detects rows Rails has that the record does not' do
      Event.create!(session: session, ai_run: ai_run, seq: 9, store_seq: 99,
                    event_type: 'ai_text', actor_kind: 'claude', payload: {})

      result = described_class.call(session: session, client: stub_harness(entries))

      # The record is authoritative, so a row beyond its high water mark is a projection
      # fault even though nothing is missing.
      expect(result.reason).to(eq(:unexpected_rows))
    end

    it 'NEVER repairs what it found' do
      Event.where(session: session, store_seq: 3).delete_all

      expect { described_class.call(session: session, client: stub_harness(entries)) }
        .not_to(change(Event, :count))
    end
  end

  describe 'the check is not vacuous' do
    it 'compares ORDER, so two rows swapped is a divergence' do
      client = stub_harness(entries)
      Events::Rederive.call(session: session, reset: true, client: client)
      # Swap the two types between store_seq 1 and 3 — same multiset, different order.
      # rubocop:disable Rails/SkipsModelValidations
      Event.where(session: session, store_seq: 1).update_all(event_type: 'run_finished')
      Event.where(session: session, store_seq: 3).update_all(event_type: 'run_started')
      # rubocop:enable Rails/SkipsModelValidations

      expect(described_class.call(session: session, client: client)).to(be_diverged)
    end

    it 'ignores `id`, which legitimately changes on a reset replay' do
      client = stub_harness(entries)
      Events::Rederive.call(session: session, reset: true, client: client)
      first_ids = Event.where(session: session).order(:store_seq).pluck(:id)

      Events::Rederive.call(session: session, reset: true, client: client)

      # Including `id` in the digest would report every rebuilt session as diverged.
      expect(Event.where(session: session).order(:store_seq).pluck(:id)).not_to(eq(first_ids))
      expect(described_class.call(session: session, client: client)).to(be_ok)
    end

    it 'reports OK on an empty session with an empty record' do
      expect(described_class.call(session: session, client: stub_harness([]))).to(be_ok)
    end
  end
end
