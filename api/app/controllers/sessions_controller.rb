# frozen_string_literal: true

# Create a session — the bootstrap entry point. Like joining (participants#create),
# this is unauthenticated: the trusted LAN is the perimeter and there is no prior
# identity before the first session exists. The creator supplies a display name +
# a title, becomes the session's `owner` participant (and host), and receives the
# signed httpOnly `clawd_uid` cookie. The response mirrors the join shape so the
# web flow (store the participant → route into the session) is identical.
class SessionsController < ApplicationController
  def create
    title = params[:title].to_s.strip
    name = params[:name].to_s.strip
    return render_blank('Title') if title.empty?
    return render_blank('Name') if name.empty?

    participant = create_session_as_owner!(title: title, name: name)
    cookies.signed[COOKIE_NAME] = cookie_options(participant.user_id)
    render(json: participant_json(participant), status: :created)
  end

  private

  def create_session_as_owner!(title:, name:)
    ActiveRecord::Base.transaction do
      user = User.find_or_create_by!(name: name)
      session = Session.create!(title: title, host: user, repository_path: params[:repository_path].presence)
      Participant.create!(session: session, user: user, role: 'owner')
    end
  end

  def cookie_options(user_id)
    # No Secure flag — the LAN is plain HTTP (documented accepted MVP risk).
    { value: user_id, httponly: true, same_site: :lax }
  end

  def participant_json(participant)
    {
      id: participant.id.to_s,
      session_id: participant.session_id.to_s,
      role: participant.role,
      name: participant.user.name
    }
  end

  def render_blank(field)
    render(json: { errors: [{ message: "#{field} can't be blank" }] }, status: :unprocessable_content)
  end
end
