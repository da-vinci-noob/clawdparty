# frozen_string_literal: true

require 'net/http'

# In development, Rails is the single published port (rails:3000). It serves
# /api and /~cable itself and reverse-proxies every OTHER request (the SPA, its
# assets, and the Vite HMR WebSocket upgrade) to the unpublished `vite` service
# over the compose network — so a LAN browser reaches everything through
# rails:3000 and never needs to hit 5173. In production this middleware is a
# no-op (the built SPA is served directly).
#
# The compose wiring (unpublished vite, single published rails port) is owned by
# dev-docker-compose; the Vite-side HMR config (server.host, hmr.clientPort,
# usePolling) is owned by web-scaffold. This middleware is the Rails-side half.
class DevSpaProxy
  # Requests Rails handles itself — never proxied to vite.
  PASSTHROUGH_PREFIXES = ['/api', '/~cable', '/up', '/rails', '/cable'].freeze

  def initialize(app, upstream: ENV.fetch('SPA_UPSTREAM', 'http://vite:5173'))
    @app = app
    @upstream = URI.parse(upstream)
  end

  def call(env)
    return @app.call(env) if rails_owned?(env['PATH_INFO'])

    proxy(env)
  end

  private

  def rails_owned?(path)
    PASSTHROUGH_PREFIXES.any? { |prefix| path == prefix || path.start_with?("#{prefix}/") }
  end

  def proxy(env)
    request = Rack::Request.new(env)
    response = forward(request)
    [response.code.to_i, proxied_headers(response), [response.body || '']]
  rescue Errno::ECONNREFUSED, SocketError, Net::OpenTimeout, Errno::EHOSTUNREACH => e
    # The vite upstream is unreachable — return a clear 502. /api and /~cable are
    # served directly by Rails (above) and are unaffected.
    [502, { 'content-type' => 'text/plain' },
     ["Bad Gateway: dev SPA upstream (#{@upstream}) unreachable (#{e.class})"]]
  end

  def forward(request)
    uri = @upstream.dup
    uri.path = request.path_info.empty? ? '/' : request.path_info
    uri.query = request.query_string.presence

    Net::HTTP.start(uri.host, uri.port, open_timeout: 2, read_timeout: 10) do |http|
      proxy_request = build_request(uri, request)
      http.request(proxy_request)
    end
  end

  def build_request(uri, request)
    klass = Net::HTTP.const_get(request.request_method.capitalize, false)
    proxy_request = klass.new(uri)
    copy_request_headers(request.env, proxy_request)
    body = request.body&.read
    proxy_request.body = body if body.present?
    proxy_request
  end

  def copy_request_headers(env, proxy_request)
    env.each do |key, value|
      next unless key.start_with?('HTTP_')
      next if key == 'HTTP_VERSION'

      header = key.delete_prefix('HTTP_').split('_').map(&:capitalize).join('-')
      proxy_request[header] = value
    end
  end

  def proxied_headers(response)
    headers = {}
    response.each_header { |k, v| headers[k] = v unless k.casecmp('transfer-encoding').zero? }
    headers
  end
end
