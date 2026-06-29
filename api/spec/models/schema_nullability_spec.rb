# frozen_string_literal: true

require 'rails_helper'

RSpec.describe('schema nullability posture') do
  let(:session) { create(:session) }

  it 'creates a W1 run with the W2-only columns null' do
    run = create(:ai_run, session: session)

    expect(run.base_sha).to(be_nil)
    expect(run.claude_session_id).to(be_nil)
    expect(run.reviewed_by_id).to(be_nil)
    expect(run.total_cost_usd).to(be_nil)
    expect(run.usage).to(be_nil)
    expect(run.diff_stats).to(be_nil)
  end

  # Each bad INSERT aborts its PG (sub)transaction, so wrap each in a savepoint
  # (requires_new) and test independently — otherwise the first abort cascades.
  it 'rejects a null ai_runs.prompt at the DB' do
    expect do
      ActiveRecord::Base.transaction(requires_new: true) do
        AiRun.connection.execute(
          'INSERT INTO ai_runs (session_id, status, model, created_at, updated_at) ' \
          "VALUES (#{session.id}, 'running', 'm', now(), now())"
        )
      end
    end.to(raise_error(ActiveRecord::NotNullViolation))
  end

  it 'rejects a null events.event_type at the DB' do
    expect do
      ActiveRecord::Base.transaction(requires_new: true) do
        Event.connection.execute(
          'INSERT INTO events (session_id, actor_kind, payload, created_at, updated_at) ' \
          "VALUES (#{session.id}, 'claude', '{}', now(), now())"
        )
      end
    end.to(raise_error(ActiveRecord::NotNullViolation))
  end
end
