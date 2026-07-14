#!/usr/bin/env bash
# Sidecar service entrypoint. Installs node_modules into the named volume, then
# starts the Fastify server. The sidecar talks to Rails over HTTP and
# ring-buffers when Rails is down, so it does NOT wait on Rails here.
set -euo pipefail

cd /app

# Install deps into the named-volume node_modules. Guarded so this works before
# `sidecar-foundation` lands a package.json: skip install if absent.
if [[ -f "package.json" ]]; then
  echo "[sidecar-entrypoint] npm install"
  if [[ -f "package-lock.json" ]]; then
    npm ci || npm install
  else
    npm install
  fi
else
  echo "[sidecar-entrypoint] no package.json yet — skipping install (sidecar-foundation not landed)"
fi

exec "$@"
