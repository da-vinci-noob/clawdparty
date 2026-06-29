# frozen_string_literal: true

require 'json'

module FakeClaude
  # Replays the executable-contract fixture (sample_run.jsonl) through the REAL
  # Events::Ingest path, in-process — no Puma, no SIDECAR_SHARED_SECRET. Powers
  # both session seeding and the happy-path system test. Per contracts Decision 9,
  # "real ingest" holds because broadcast lives inside Events::Ingest.
  class Replay
    FIXTURE = Rails.root.join('../packages/contracts/fixtures/sample_run.jsonl')

    # The contract major this consumer is built against (event-envelope v1).
    REQUIRED_CONTRACT = { major: 1, minor: 0 }.freeze

    def self.call(session: nil)
      new(session: session).call
    end

    def initialize(session: nil)
      @session = session
    end

    def call
      assert_contract_compatible!
      target = build_target
      counts = { accepted: 0, broadcast: 0, skipped: 0, total: 0 }

      each_fixture_event do |raw|
        counts[:total] += 1
        result = Events::Ingest.call(remap(raw, target))
        counts[result.status] += 1
      end

      # Terminal status so a subsequent fresh replay does not violate the
      # partial-unique active-run index.
      target[:ai_run].update!(status: 'completed_clean')

      counts.merge(session_id: target[:session].id, ai_run_id: target[:ai_run].id)
    end

    private

    attr_reader :session

    def build_target
      sess = session || Session.create!(title: "Replay #{Time.current.to_i}")
      user = User.find_or_create_by!(name: 'fake-claude-host')
      participant = Participant.find_or_create_by!(session: sess, user: user) do |p|
        p.role = 'owner'
      end
      run = AiRun.create!(
        session: sess,
        status: 'running',
        requested_by: participant,
        prompt: '(replay placeholder prompt)',
        model: '(replay placeholder model)'
      )
      { session: sess, ai_run: run, participant: participant }
    end

    # Remap the 3 ids so events reference real rows and repeated replays do not
    # collide on the unique indexes; preserve seq paired with the new ai_run_id.
    def remap(raw, target)
      actor = (raw['actor'] || {}).dup
      actor['id'] = target[:participant].id if actor['kind'] == 'user'

      raw.merge(
        'session_id' => target[:session].id,
        'ai_run_id' => (target[:ai_run].id unless raw['ai_run_id'].nil?),
        'actor' => actor
      )
    end

    def each_fixture_event
      File.foreach(FIXTURE) do |line|
        line = line.strip
        next if line.empty?

        yield(JSON.parse(line))
      end
    end

    # Exercise the contracts-package governance: require an EXACT major and a
    # minor >= what we need, so a breaking major bump fails loudly here.
    def assert_contract_compatible!
      actual = ContractVersion.current
      compatible = actual[:major] == REQUIRED_CONTRACT[:major] &&
                   actual[:minor] >= REQUIRED_CONTRACT[:minor]
      return if compatible

      raise(IncompatibleContract,
            "contract #{actual.inspect} incompatible with required #{REQUIRED_CONTRACT.inspect}")
    end

    class IncompatibleContract < StandardError; end
  end
end
