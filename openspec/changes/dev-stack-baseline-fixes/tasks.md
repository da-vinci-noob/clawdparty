## 1. Package mount

- [x] 1.1 Add `- ./packages:/packages:ro` to the `sidecar` service `volumes:` in `docker-compose.yml`
- [x] 1.2 Add `- ./packages:/packages:ro` to the `vite` service `volumes:` in `docker-compose.yml`

## 2. HMR WebSocket tunnel

- [x] 2.1 In `api/app/middleware/dev_spa_proxy.rb`, detect `Upgrade: websocket` on non-Rails-owned paths and route to a tunnel instead of the `Net::HTTP` path
- [x] 2.2 Implement the tunnel via `rack.hijack`: open a `TCPSocket` to the vite upstream, replay the handshake (request line + `HTTP_*` headers), pump bytes bidirectionally, close both sockets on EOF/error
- [x] 2.3 When `rack.hijack` is unavailable, return `502` (never forward an upgrade over `Net::HTTP`)

## 3. Tests

- [x] 3.1 Extend `api/spec/middleware/dev_spa_proxy_spec.rb`: upgrade on a proxied path with no hijack support → `502`; upgrade on `/~cable` → handled downstream (not tunneled); non-upgrade proxied path still `502` on unreachable upstream (unchanged)

## 4. Verification (requires Docker + Ruby toolchain — run by reviewer)

- [ ] 4.1 `cd api && bundle exec rubocop app/middleware/dev_spa_proxy.rb spec/middleware/dev_spa_proxy_spec.rb`
- [ ] 4.2 `bin/rspec spec/middleware/dev_spa_proxy_spec.rb`
- [ ] 4.3 Clean-volume boot: `docker compose down -v && bin/start`; confirm `sidecar` and `vite` complete `npm ci` (contracts resolved) and stay up
- [ ] 4.4 HMR smoke: open the SPA through `rails:3000`, edit a `web/src` file, confirm the browser hot-updates without a full reload and the HMR ws shows connected (no repeated reconnect errors in the console)
