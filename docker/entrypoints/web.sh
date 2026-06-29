#!/usr/bin/env bash
# Web/Vite service entrypoint. Installs node_modules into the named volume, then
# starts the Vite dev server.
set -euo pipefail

cd /app

if [[ -f "package.json" ]]; then
  echo "[web-entrypoint] npm install"
  if [[ -f "package-lock.json" ]]; then
    npm ci || npm install
  else
    npm install
  fi
else
  echo "[web-entrypoint] no package.json yet — skipping install (web-scaffold not landed)"
fi

exec "$@"
