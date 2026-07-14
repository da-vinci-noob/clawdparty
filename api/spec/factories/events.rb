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
FactoryBot.define do
  # Default: a durable, run-scoped, claude-attributed event.
  factory :event do
    session
    ai_run
    event_type { 'ai_text' }
    actor_kind { 'claude' }
    sequence(:seq) { |n| n }
    payload { {} }

    trait :user_actor do
      actor_kind { 'user' }
      actor_participant { association :participant, session: session }
    end

    trait :system_actor do
      actor_kind { 'system' }
    end

    # Session-scoped (no run): chat, participant, task.
    trait :session_scoped do
      ai_run { nil }
      seq { nil }
      event_type { 'chat_message' }
      actor_kind { 'user' }
      actor_participant { association :participant, session: session }
    end

    # Ephemeral: broadcast-not-persisted, null id + null seq.
    trait :ephemeral do
      event_type { 'ai_text_delta' }
      actor_kind { 'claude' }
      seq { nil }
    end
  end
end
