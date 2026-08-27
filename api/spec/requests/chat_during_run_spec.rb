# frozen_string_literal: true

require 'rails_helper'

# chat is NOT gated on run state.
#
# The premise this protects: clawdparty turns one Claude session into a shared room.
# People talk to each other WHILE Claude works — that is most of what makes it a room
# rather than a queue. A plausible-looking optimisation ("lock the session while a run
# is active, to avoid interleaving") would quietly remove it, and every test that only
# exercises chat on an idle session would still pass.
#
# So the assertions here are deliberately about the ACTIVE-RUN case, and about chat
# landing on the same stream as run activity rather than a side channel.
RSpec.describe('Chat during a live run') do
  let(:session) { create(:session) }
  let!(:run) { create(:ai_run, session: session, status: 'running') }

  def post_chat(body: 'what is it doing?')
    post("/api/sessions/#{session.id}/messages", params: { body: body })
  end

  %w[owner editor reviewer viewer].each do |role|
    it "lets a #{role} post chat while a run is running" do
      join_as(session, role: role)

      expect { post_chat }.to(change(Message, :count).by(1))
      expect(response).to(have_http_status(:created))
    end
  end

  it 'is unaffected by the run reaching awaiting_review' do
    run.update!(status: 'awaiting_review')
    join_as(session, role: 'reviewer')

    expect { post_chat(body: 'the diff looks wrong to me') }.to(change(Message, :count).by(1))
    expect(response).to(have_http_status(:created))
  end

  it 'puts chat on the SAME event stream as run activity, not a side channel' do
    join_as(session, role: 'editor')
    create(:event, session: session, ai_run: run, event_type: 'ai_text', seq: 1)

    post_chat(body: 'hold on')

    # One ordered stream is the whole Contract-1 premise: a late joiner replays
    # exactly what everyone else saw, in the order they saw it. A separate chat
    # channel would leave the two orderings unreconcilable.
    stream = Event.where(session_id: session.id).order(:id)
    expect(stream.pluck(:event_type)).to(include('ai_text', 'chat_message'))
    expect(stream.last.event_type).to(eq('chat_message'))
  end

  it 'attributes the chat event to the posting participant, not the system' do
    participant = join_as(session, role: 'editor')

    post_chat

    event = Event.where(session_id: session.id, event_type: 'chat_message').last
    expect(event.actor_kind).to(eq('user'))
    expect(event.actor_participant_id).to(eq(participant.id))
  end

  it 'gives chat a null ai_run_id even while a run is active' do
    join_as(session, role: 'editor')

    post_chat

    # Chat is session-scoped. Stamping it with the active run would make it vanish
    # from the feed the moment that run is filtered out.
    event = Event.where(session_id: session.id, event_type: 'chat_message').last
    expect(event.ai_run_id).to(be_nil)
    expect(event.seq).to(be_nil)
  end

  it 'still refuses a non-participant, run or no run' do
    expect { post_chat }.not_to(change(Message, :count))
    expect(response).to(have_http_status(:not_found))
  end
end
