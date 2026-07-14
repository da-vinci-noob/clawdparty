# frozen_string_literal: true

# == Schema Information
#
# Table name: events
# Database name: primary
#
#  id                   :bigint           not null, primary key
#  actor_kind           :enum             not null
#  event_type           :string           not null
#  payload              :jsonb            not null
#  seq                  :bigint
#  created_at           :datetime         not null
#  updated_at           :datetime         not null
#  actor_participant_id :bigint
#  ai_run_id            :bigint
#  session_id           :bigint           not null
#
# Indexes
#
#  index_events_on_actor_participant_id  (actor_participant_id)
#  index_events_on_ai_run_id             (ai_run_id)
#  index_events_on_run_and_seq           (ai_run_id,seq) UNIQUE
#  index_events_on_session_id            (session_id)
#
# Foreign Keys
#
#  fk_rails_...  (actor_participant_id => participants.id)
#  fk_rails_...  (ai_run_id => ai_runs.id)
#  fk_rails_...  (session_id => sessions.id)
#
class Event < ApplicationRecord
  ACTOR_KINDS = %w[claude user system].freeze

  # The 20 frozen type names + the `ai_raw` fallback (Contract 1 / events.md).
  # Kept in sync with packages/contracts/src/events.ts; a spec asserts membership.
  TAXONOMY = %w[
    run_started ai_text_delta ai_text ai_thinking
    tool_started tool_finished tool_failed terminal_output file_changed
    run_finished run_failed run_interrupted
    changeset_ready changeset_approved changeset_rejected
    chat_message task_created task_updated participant_joined presence_changed
  ].freeze
  AI_RAW = 'ai_raw'

  # Broadcast-but-never-persisted types (null id, null seq).
  EPHEMERAL_TYPES = %w[ai_text_delta presence_changed].freeze

  belongs_to :session
  belongs_to :ai_run, optional: true
  belongs_to :actor_participant, class_name: 'Participant', optional: true

  enum :actor_kind, ACTOR_KINDS.index_with(&:itself), validate: true

  validates :event_type, presence: true

  # Append-only: no updates or destroys in normal operation.
  def readonly?
    !new_record?
  end

  def self.ephemeral_type?(type)
    EPHEMERAL_TYPES.include?(type.to_s)
  end

  def ephemeral?
    self.class.ephemeral_type?(event_type)
  end

  # Serialize a persisted row to the frozen Contract-1 envelope. Integer FKs
  # become STRING ids; a null ai_run_id serializes as null (not "null"); `ts`
  # is created_at rendered as ISO-8601 UTC ms+Z (NOT Rails' default JSON time).
  def to_envelope
    {
      id: id,
      session_id: session_id.to_s,
      ai_run_id: ai_run_id&.to_s,
      seq: seq,
      type: event_type,
      actor: actor_hash,
      ts: self.class.iso_ms(created_at),
      payload: payload
    }
  end

  def actor_hash
    case actor_kind
    when 'user' then { kind: 'user', id: actor_participant_id.to_s }
    else { kind: actor_kind }
    end
  end

  # ISO-8601 UTC, millisecond precision, Z suffix (e.g. 2026-06-28T20:11:05.123Z).
  def self.iso_ms(time)
    "#{time.utc.strftime('%Y-%m-%dT%H:%M:%S.%L')}Z"
  end
end
