# frozen_string_literal: true

# Reads the contract straight from the frozen TS source of truth
# (packages/contracts/src/events.ts) so Ruby never hardcodes its own copy and
# cannot drift. Exercises the contracts-package governance mechanism from a real
# consumer (FakeClaude::Replay asserts compatibility).
#
# Read at CALL time, never at load time: api/ must boot without packages/ present.
# Ruby's copies of the taxonomy live in Event and are asserted equal to these.
module ContractVersion
  EVENTS_TS = Rails.root.join('../packages/contracts/src/events.ts')

  class Unreadable < StandardError; end

  module_function

  def current
    match = source.match(/CONTRACT_VERSION\s*=\s*\{\s*major:\s*(\d+),\s*minor:\s*(\d+)\s*\}/)
    raise(Unreadable, "could not parse CONTRACT_VERSION from #{EVENTS_TS}") unless match

    { major: match[1].to_i, minor: match[2].to_i }
  end

  def event_types
    parse_list('EVENT_TYPES')
  end

  def ephemeral_event_types
    parse_list('EPHEMERAL_EVENT_TYPES')
  end

  def parse_list(const)
    body = source[/export const #{const}\s*=\s*\[(.*?)\]\s*as const;/m, 1]
    raise(Unreadable, "could not parse #{const} from #{EVENTS_TS}") unless body

    # Strip // comments before scanning: EVENT_TYPES carries a section divider,
    # and its words would otherwise be collected as type names.
    body.gsub(%r{//[^\n]*}, '').scan(/"([a-z_]+)"/).flatten
  end

  def source
    File.read(EVENTS_TS)
  rescue Errno::ENOENT => e
    raise(Unreadable, e.message)
  end
end
