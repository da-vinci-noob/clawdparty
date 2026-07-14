# frozen_string_literal: true

# Reads CONTRACT_VERSION straight from the frozen TS source of truth
# (packages/contracts/src/events.ts), so Ruby never hardcodes its own copy and
# cannot drift from the contract. Exercises the contracts-package governance
# mechanism from a real consumer (FakeClaude::Replay asserts compatibility).
module ContractVersion
  EVENTS_TS = Rails.root.join('../packages/contracts/src/events.ts')

  class Unreadable < StandardError; end

  module_function

  def current
    source = File.read(EVENTS_TS)
    match = source.match(/CONTRACT_VERSION\s*=\s*\{\s*major:\s*(\d+),\s*minor:\s*(\d+)\s*\}/)
    raise(Unreadable, "could not parse CONTRACT_VERSION from #{EVENTS_TS}") unless match

    { major: match[1].to_i, minor: match[2].to_i }
  rescue Errno::ENOENT => e
    raise(Unreadable, e.message)
  end
end
