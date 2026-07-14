# frozen_string_literal: true

namespace :fake_claude do
  desc 'Replay packages/contracts/fixtures/sample_run.jsonl through Events::Ingest (in-process)'
  task replay: :environment do
    result = FakeClaude::Replay.call
    puts "Replayed #{result[:total]} events into session=#{result[:session_id]} " \
         "run=#{result[:ai_run_id]} (accepted=#{result[:accepted]} " \
         "broadcast_only=#{result[:broadcast]} skipped=#{result[:skipped]})"
  end
end
