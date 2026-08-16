# frozen_string_literal: true

# The 4-role permission matrix from the frozen http-api-contract capability
# (owner > editor > reviewer > viewer). The server is the source of truth; the
# client only hides buttons. Action symbols map to the matrix rows.
class SessionPolicy
  class NotAuthorized < StandardError; end

  # role => set of permitted action symbols.
  #
  # Every row here MUST be checked by real code — `review_roles_spec.rb` asserts it.
  # A capability nothing enforces reads as a live privilege and invites someone to
  # wire it up again. Two were removed for that reason: `bypass_permissions` gated
  # the `permission_mode` parameter, which no longer exists, and `manage_tasks`
  # gated the task board, which was cut from the MVP.
  MATRIX = {
    'owner' => %i[view chat run interrupt approve reject
                  manage_invites manage_session archive].freeze,
    'editor' => %i[view chat run interrupt approve reject].freeze,
    'reviewer' => %i[view chat approve reject].freeze,
    'viewer' => %i[view chat].freeze
  }.freeze

  attr_reader :participant, :session

  def initialize(participant:, session:)
    @participant = participant
    @session = session
  end

  def can?(action)
    return false if participant.nil?

    MATRIX.fetch(participant.role, []).include?(action)
  end

  def authorize!(action)
    raise(NotAuthorized, "role #{participant&.role.inspect} cannot #{action}") unless can?(action)

    true
  end
end
