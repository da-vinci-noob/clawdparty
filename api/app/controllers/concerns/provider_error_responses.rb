# frozen_string_literal: true

# Maps provider/model resolution failures to their client HTTP responses.
#
# Split from `RunErrorResponses` because it is a different subject: those map the run
# LIFECYCLE (already active, dirty worktree, archived session), these map "this host cannot
# serve the run you asked for". Both forward the underlying reason verbatim, because in each
# case the specific credential or provider is the only actionable part.
module ProviderErrorResponses
  extend ActiveSupport::Concern

  included do
    # The harness ANSWERED and refused. "store unavailable for session 35:
    # incompatible_version" tells an operator what to do; "the harness is unavailable" does
    # not, and is also untrue — which is why this is distinct from TransportError.
    rescue_from Harness::Client::Refused do |error|
      render_error("The harness refused the run: #{error.message}", :unprocessable_content)
    end

    # No model this host can serve. The message carries the provider's own remedy, so a
    # Bedrock host with an expired SSO session is told to run `aws sso login` rather than
    # shown an invalid-model-id error from the provider two steps later.
    rescue_from Runs::ResolveModel::Unresolvable do |error|
      render_error("Cannot start a run: #{error.message}", :unprocessable_content)
    end
  end
end
