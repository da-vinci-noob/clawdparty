# frozen_string_literal: true

namespace :harness do
  desc 'reconcile ai_runs against the harness GET /runs (the harness wins)'
  task reconcile: :environment do
    result = Harness::Reconcile.call

    if result.unreachable?
      warn('[harness:reconcile] harness unreachable — reconciled nothing (a missing answer is not an empty run list)')
      next
    end

    puts("[harness:reconcile] failed=#{result.failed.size} restored=#{result.restored.size} " \
         "conflicts=#{result.conflicts.size} unknown=#{result.unknown.size}")
    if result.unknown.any?
      warn("[harness:reconcile] harness holds run(s) Rails has no row for: #{result.unknown.join(', ')}")
    end
    next if result.conflicts.empty?

    warn("[harness:reconcile] UNRESOLVED: the harness still holds run(s) #{result.conflicts.join(', ')} " \
         'whose change Rails already approved or rejected — the worktree was committed or reverted, ' \
         'so neither view can be adopted without lying about it')
  end
end
