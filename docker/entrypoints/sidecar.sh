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

# ~/.claude.json (where Claude Code stores the user's MCP servers) is a FILE the
# app atomically rewrites (write-temp + rename), which swaps the inode and breaks
# a live single-file bind mount (the container sees it vanish). Snapshot the
# read-only side-mount ONCE at startup into a stable path the discovery code reads.
# Refreshed each restart; the MCP server list changes rarely, so a snapshot is fine.
if [[ -f "/home/node/.claude-host.json" ]]; then
  cp -f /home/node/.claude-host.json /home/node/.claude-host-cache.json 2>/dev/null || true
fi

exec "$@"
