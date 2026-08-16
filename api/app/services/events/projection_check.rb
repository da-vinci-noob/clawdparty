# frozen_string_literal: true

require 'digest'

module Events
  # Detect a projection that has diverged from the record.
  #
  # `events` is a projection of the harness's store, and a projection that is quietly
  # wrong is worse than one that is visibly missing: the feed looks complete and every
  # number read off it is false. So divergence is REPORTED, never auto-healed — a repair
  # that runs silently destroys the evidence of what went wrong. `Events::Rederive` is the
  # repair, and it is a separate, deliberate call.
  #
  # Two comparisons, because each misses what the other catches:
  #
  #   high water   `max(store_seq)` on both sides. Catches a SKIPPED batch, which is the
  #                common failure — Rails was down, or the ring buffer overflowed.
  #   digest       A rolling digest over the ordered `(store_seq, type, seq)` triples.
  #                Catches a MUTATED row and a DUPLICATED one, both of which leave the
  #                high water mark untouched and are therefore invisible to it.
  #
  # The digest deliberately excludes `payload` and `id`. `id` is assigned by Postgres and
  # legitimately differs after a reset re-derivation, so including it would report every
  # rebuilt session as diverged. `payload` is JSONB and its key order is not stable across
  # a round trip, so it would produce false mismatches — the structural triple is what a
  # divergence actually shows up in.
  class ProjectionCheck
    Result = Struct.new(:diverged, :reason, :rails_high_water, :harness_high_water,
                        :rails_digest, :harness_digest, :rails_count, :harness_count,
                        keyword_init: true) do
      def diverged? = diverged
      def ok? = !diverged
    end

    def self.call(session:, client: Harness::Client.new)
      new(session: session, client: client).call
    end

    def initialize(session:, client: Harness::Client.new)
      @session = session
      @client = client
    end

    def call
      harness = harness_triples
      rails = rails_triples

      compare(rails, harness)
    end

    private

    attr_reader :session, :client

    def compare(rails, harness)
      base = {
        rails_high_water: high_water(rails), harness_high_water: high_water(harness),
        rails_digest: digest(rails), harness_digest: digest(harness),
        rails_count: rails.size, harness_count: harness.size
      }
      reason = reason_for(base)

      Result.new(diverged: !reason.nil?, reason: reason, **base)
    end

    # High water FIRST: when a batch is missing it names the actual problem, where a digest
    # mismatch only says "something differs" and sends a reader hunting.
    def reason_for(base)
      return :missing_batch if base[:rails_high_water] < base[:harness_high_water]
      return :unexpected_rows if base[:rails_high_water] > base[:harness_high_water]
      return :content_mismatch if base[:rails_digest] != base[:harness_digest]

      nil
    end

    def rails_triples
      Event.where(session: session)
           .where.not(store_seq: nil)
           .order(:store_seq)
           .pluck(:store_seq, :event_type, :seq)
    end

    def harness_triples
      response = client.list_entries(session.id, after: 0)
      raise(Harness::Client::TransportError, "harness returned #{response.status}") unless response.status == 200

      Array(response.body['entries'] || response.body[:entries])
        .map(&:with_indifferent_access)
        .sort_by { |e| e[:store_seq].to_i }
        .map { |e| [e[:store_seq], e[:type], e[:seq]] }
    end

    def high_water(triples) = triples.map { |t| t[0].to_i }.max || 0

    # Rolling rather than a set hash: order is part of what is being compared, and two
    # rows swapped is a divergence a set would call equal.
    def digest(triples)
      triples.reduce(Digest::SHA256.new) do |acc, (store_seq, type, seq)|
        acc << "#{store_seq}|#{type}|#{seq}\n"
      end.hexdigest
    end
  end
end
