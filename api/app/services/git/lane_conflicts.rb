# frozen_string_literal: true

require 'open3'

module Git
  # Files this run changed that ANOTHER lane has also changed.
  #
  # With one worktree and one branch per lane, two lanes editing the same file is no longer
  # an automatic collision — git never sees them meet. That is exactly why it has to be REPORTED:
  # nothing will surface it on its own, and approving both leaves two divergent versions of the file
  # with no reconciliation anywhere. "Surfaced rather than silently resolved" means the reviewer is
  # told before they approve, not that the app picks a winner.
  #
  # Two kinds, because they call for different judgement:
  #
  #   `unreviewed` — another lane has a changeset waiting on the same file. Whoever reviews second
  #                  is deciding for both, and should know that.
  #   `approved`   — another lane's change to this file is already committed on its own branch. This
  #                  lane's work is built on a version of the file that no longer reflects the
  #                  session's accepted state.
  #
  # NEVER raises into the diff. A conflict report is additional information, and a session must stay
  # reviewable when a sibling lane's worktree has been pruned, moved, or never created — so an
  # unreadable lane contributes nothing rather than failing the endpoint that was asked for a diff.
  class LaneConflicts
    Conflict = Struct.new(:path, :lane, :kind, keyword_init: true)

    # Statuses that mean "this lane has a changeset a human has not settled yet".
    UNREVIEWED_STATUSES = %w[awaiting_review].freeze
    APPROVED_STATUSES = %w[approved].freeze

    def self.call(**)
      new(**).call
    end

    def initialize(run:, paths:)
      @run = run
      @paths = paths.to_set
    end

    def call
      return [] if @paths.empty?

      sibling_runs.flat_map { |sibling| conflicts_with(sibling) }.uniq { |c| [c.path, c.lane] }
    end

    private

    # Every other lane's most recent unsettled-or-approved run. Ordered so one row per lane wins:
    # the newest, since an older approved changeset in the same lane is already superseded by it.
    def sibling_runs
      @run.session.ai_runs
          .where(status: UNREVIEWED_STATUSES + APPROVED_STATUSES)
          .where.not(lane: @run.lane)
          .order(id: :desc)
          .uniq(&:lane)
    end

    def conflicts_with(sibling)
      kind = UNREVIEWED_STATUSES.include?(sibling.status) ? 'unreviewed' : 'approved'
      overlapping = changed_paths(sibling, kind) & @paths
      overlapping.map { |path| Conflict.new(path: path, lane: sibling.lane, kind: kind) }
    end

    # What that lane changed: its uncommitted working tree for an unreviewed changeset, or what it
    # committed since its own base for an approved one.
    def changed_paths(sibling, kind)
      dir = WorktreeManager.new(sibling.session, lane: sibling.lane).worktree_path
      return Set.new unless File.directory?(dir)

      args = kind == 'unreviewed' ? ['diff', 'HEAD', '--name-only'] : commit_range_args(sibling)
      return Set.new if args.nil?

      name_only(dir, args)
    end

    # `<base>..HEAD --name-only`. Without a recorded base there is no range to ask about, and
    # guessing one would report files this lane never touched.
    def commit_range_args(sibling)
      return nil if sibling.base_sha.blank?

      ['diff', "#{sibling.base_sha}..HEAD", '--name-only']
    end

    def name_only(dir, args)
      stdout, _stderr, status = Open3.capture3('git', '-C', dir, *args)
      return Set.new unless status.success?

      stdout.each_line.map(&:strip).compact_blank.to_set
    end
  end
end
