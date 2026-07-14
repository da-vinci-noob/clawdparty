# frozen_string_literal: true

# Late-joiner backfill: GET /api/sessions/:session_id/events?after=<cursor>.
# Returns an ordered array of Contract-1 envelopes with id > cursor, ascending
# by id, scoped to the session. A non-participant (or unknown session) gets 404
# (NOT 403), so the response never confirms another session's existence.
# (Routed under the /api path scope.)
class EventsController < ApplicationController
  before_action :require_user

  def index
    session = Session.find_by(id: params[:session_id])
    # 404 if the session is unknown OR the requester is not a participant.
    raise(ActiveRecord::RecordNotFound) if session.nil? || participant_for(session).nil?

    events = session.events
                    .where('events.id > ?', cursor)
                    .order(:id)
    render(json: events.map(&:to_envelope), status: :ok)
  end

  private

  def cursor
    params[:after].to_i # absent/blank => 0 => all events
  end
end
