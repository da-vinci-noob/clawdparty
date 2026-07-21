# frozen_string_literal: true

# The 4-role permission matrix from the frozen http-api-contract capability
# (owner > editor > reviewer > viewer). The server is the source of truth; the
# client only hides buttons. Action symbols map to the matrix rows.
class SessionPolicy
  class NotAuthorized < StandardError; end

  # role => set of permitted action symbols.
  MATRIX = {
    'owner' => %i[view chat manage_tasks run interrupt approve reject
                  manage_invites manage_session archive bypass_permissions].freeze,
    'editor' => %i[view chat manage_tasks run interrupt approve reject].freeze,
    'reviewer' => %i[view chat manage_tasks approve reject].freeze,
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
