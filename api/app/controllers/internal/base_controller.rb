# frozen_string_literal: true

module Internal
  # Bearer-authenticated harness→Rails callbacks. These do NOT run SessionPolicy
  # (they ride the private compose network with a shared secret), so they never
  # return 403/404 for auth — only 401 on a bad bearer. Constant-time compare.
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
