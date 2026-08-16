# frozen_string_literal: true

module Internal
  # Bearer-authenticated harness→Rails callbacks. These do NOT run SessionPolicy — they
  # carry no participant identity — so they never return 403/404 for auth, only 401 on a
  # bad bearer. Constant-time compare.
  #
  # THE BEARER IS THE ONLY BOUNDARY. An earlier version of this comment justified that by
  # saying these routes "ride the private compose network", which stopped being true when
  # the harness moved onto the host: `rails:3000` is the one PUBLISHED port, so
  # `/api/internal/*` is reachable from the LAN like every other route. The secret is what
  # protects it, which is also why an empty `HARNESS_SHARED_SECRET` must never
  # authenticate.
  class BaseController < ActionController::API
    before_action :authenticate_harness!

    private

    def authenticate_harness!
      provided = request.headers['Authorization'].to_s.delete_prefix('Bearer ')
      expected = ENV.fetch('HARNESS_SHARED_SECRET', '')
      return if expected.present? &&
                ActiveSupport::SecurityUtils.secure_compare(provided, expected)

      render(json: { errors: [{ message: 'Unauthorized' }] }, status: :unauthorized)
    end
  end
end
