# frozen_string_literal: true

module Harness
  # on boot, agree with the harness about which runs are active.
  #
  # The harness holds the record; Rails holds a projection of it. So on any
  # disagreement the harness wins, and this service moves `ai_runs` to match rather
  # than the other way around.
  #
  # Two rules that are easy to get backwards:
  #
  # 1. An UNREACHABLE harness reconciles nothing. A connection error is not an empty
  #    run list — treating it as one would fail every live run whenever Rails boots
  #    while the harness is briefly down. Genuinely-lost runs are already swept by
  #    HealthcheckJob on staleness, so declining to act here loses nothing.
  # 2. Losers are settled BEFORE winners are restored. Restoring a run to `running`
  #    while the session still holds a different active run violates
  #    index_ai_runs_one_active_per_session; failing the run the harness has lost
  #    first is what frees the slot.
  class Reconcile
    # Only these can disagree with the harness. `awaiting_review` is past the harness's
    # involvement entirely — it finished the run and dropped it — so its absence from
    # GET /runs is expected, not a disagreement. Same set HealthcheckJob sweeps, taken
    # from there so the boundary is defined once.
    RECONCILABLE_STATUSES = HealthcheckJob::SWEEPABLE_STATUSES

    # A run the harness still holds can be restored to `running` from these: each was
    # reached by Rails deciding on its own that the run was over.
    RESTORABLE_STATUSES = %w[failed completed_clean interrupted superseded].freeze

    Result = Struct.new(:status, :failed, :restored, :conflicts, :unknown, keyword_init: true) do
      def reconciled? = status == :reconciled
      def unreachable? = status == :unreachable
    end

    def self.call(**)
      new(**).call
    end

    def initialize(client: Client.new)
      @client = client
    end

    def call
      reported = fetch_reported
      return Result.new(status: :unreachable, failed: [], restored: [], conflicts: [], unknown: []) if reported.nil?

      cursors = placeable(reported)
      record_cursors(cursors)
      failed = fail_runs_the_harness_lost(cursors.keys)
      restored, conflicts = restore_runs_the_harness_holds(cursors.keys)

      Result.new(
        status: :reconciled, failed: failed, restored: restored, conflicts: conflicts,
        unknown: unplaceable(reported, cursors.keys)
      )
    end

    private

    attr_reader :client

    # `{ run_id => store_seq }` keyed by the RAW wire id, or nil when the harness could
    # not be asked. Raw because a harness run_id is a string and is not required to be
    # numeric — narrowing happens in `placeable`, and what does not survive it is
    # reported rather than dropped.
    def fetch_reported
      res = client.list_runs
      return nil unless res.status == 200

      Array(res.body['runs']).to_h { |run| [run['run_id'].to_s, run['store_seq']] }
    rescue Client::TransportError
      nil
    end

    # Only a numeric id can address an `ai_runs` row. `String#to_i` would turn
    # "run_abc" into 0 — a WHERE that looks like a real lookup, matches nothing, and
    # leaves the run the harness actually holds looking lost.
    def placeable(reported)
      reported.filter_map { |id, seq| [id.to_i, seq] if id.match?(/\A\d+\z/) }.to_h
    end

    # Everything the harness holds that Rails cannot place: a non-numeric id, or a
    # numeric one with no row. Reported together because the consequence is the same —
    # the harness is running something Rails has no record of.
    def unplaceable(reported, ids)
      opaque = reported.keys.grep_v(/\A\d+\z/)
      opaque + (ids - AiRun.where(id: ids).pluck(:id)).map(&:to_s)
    end

    def record_cursors(reported)
      reported.each do |id, store_seq|
        next if store_seq.nil?

        AiRun.where(id: id).update_all(harness_store_seq: store_seq) # rubocop:disable Rails/SkipsModelValidations
      end
    end

    def fail_runs_the_harness_lost(live_ids)
      AiRun.where(status: RECONCILABLE_STATUSES).where.not(id: live_ids).map do |run|
        append_failure(run)
        run.id
      end
    end

    # The harness holds a run Rails had already concluded. `approved`/`rejected` are the
    # one pair this cannot resolve: both already acted on the worktree (commit / revert),
    # so calling the run `running` again would describe work on a tree that no longer
    # exists. Report the conflict instead of inventing a state for it.
    def restore_runs_the_harness_holds(live_ids)
      restored = []
      conflicts = []

      AiRun.where(id: live_ids).where.not(status: AiRun::ACTIVE_STATUSES).find_each do |run|
        if RESTORABLE_STATUSES.include?(run.status)
          run.update!(status: 'running', last_heartbeat_at: Time.current)
          restored << run.id
        else
          conflicts << run.id
        end
      end

      [restored, conflicts]
    end

    def append_failure(run)
      Events::Append.call(
        session: run.session,
        event: {
          type: 'run_failed',
          actor: { kind: 'system' },
          ai_run_id: run.id,
          seq: (run.events.maximum(:seq) || 0) + 1,
          payload: {
            stop_reason: 'harness_lost_run',
            api_error_status: nil,
            total_cost_usd: run.total_cost_usd || 0,
            usage: run.usage || {}
          }
        }
      ) { run.update!(status: 'failed') }
    end
  end
end
