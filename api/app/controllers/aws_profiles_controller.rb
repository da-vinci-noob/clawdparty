# frozen_string_literal: true

# The AWS named profiles the host has configured, for the Provider settings tab.
#
# NAMES ONLY — the harness parses section headers out of `~/.aws/config` and never opens
# `~/.aws/credentials`, so no credential value is read anywhere in this path. Enumerated
# rather than free-typed because a wrong profile name fails later as an opaque AWS credential error,
# and whoever typed it has no way to learn which names are valid.
#
# Host-wide like `GET /api/models`, so it is not session-nested and any authenticated participant may
# read it: knowing which profiles exist is not an owner secret, while CHOOSING one is owner-only
# (it decides whose account pays).
class AwsProfilesController < ApplicationController
  before_action :require_user

  rescue_from Harness::Client::TransportError do
    render(json: { errors: [{ message: 'The harness is unavailable; try again' }] }, status: :bad_gateway)
  end

  # GET /api/aws-profiles
  def index
    render(json: Harness::Client.new.list_aws_profiles.body, status: :ok)
  end
end
