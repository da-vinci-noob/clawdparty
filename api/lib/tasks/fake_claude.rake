# frozen_string_literal: true

namespace :fake_claude do
  desc 'Replay packages/contracts/fixtures/sample_run.jsonl through Events::Ingest (in-process)'
  task replay: :environment do
    version = ContractVersion.current
    result = FakeClaude::Replay.call
    puts "Replayed #{result[:total]} events into session=#{result[:session_id]} " \
         "run=#{result[:ai_run_id]} (accepted=#{result[:accepted]} " \
         "broadcast_only=#{result[:broadcast]} skipped=#{result[:skipped]})"
    # Which contract the run was replayed against — otherwise the counts alone
    # cannot tell you whether a changed total means a new fixture or a stale one.
    puts "Contract v#{version[:major]}.#{version[:minor]} · " \
         "#{Event::TAXONOMY.size} types (#{Event::EPHEMERAL_TYPES.size} ephemeral)"
  end
end
