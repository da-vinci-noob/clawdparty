# Harness image — Node 24 (pinned; the host runs a newer Node, but the container
# runtime is deterministic). Runs the Fastify server that owns the agent loop.
FROM node:24-slim

# git is required: the harness runs git inside the bind-mounted target repo's
# worktrees (created by the root `rails` service).
#
# python3/make/g++ are required by better-sqlite3, the harness store's driver. It is
# a NATIVE module, and node:24-slim ships no build toolchain, so npm falls back to
# compiling from source and node-gyp fails with "not ok". CI does not hit this — it
# installs on a bare ubuntu runner where a prebuild exists — so the failure appears
# only when running the stack, which is the worst place to discover it.
RUN apt-get update -qq \
  && apt-get install --no-install-recommends -y git curl python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Cross-uid git ownership: `rails` runs as root and creates worktrees under
# /repo/.clawdparty/worktrees/*, while THIS service runs git as the non-root
# `node` user. Git 2.35.2+ rejects a repo owned by a different uid ("detected
# dubious ownership"). Mark the repo + worktrees safe so the node user accepts
# the root-created worktrees. (Preferred over aligning uids, which would break
# ~ -> /home/node credential resolution.) Written to the global gitconfig so it
# applies regardless of the running user.
RUN git config --system --add safe.directory /repo \
  && git config --system --add safe.directory '/repo/.clawdparty/worktrees/*'

WORKDIR /app

# Pre-create the node_modules mountpoint owned by `node`. A fresh named volume
# is seeded from the image at this path, so it inherits `node` ownership and the
# non-root user can install into it at entrypoint time.
RUN mkdir -p /app/node_modules && chown -R node:node /app

COPY docker/entrypoints/harness.sh /usr/local/bin/harness-entrypoint
RUN chmod +x /usr/local/bin/harness-entrypoint

# Run as the non-root `node` user shipped by the base image (home /home/node).
# Load-bearing: the SDK resolves ~/.claude and ~/.aws via `~`, so the credential
# mounts in docker-compose.yml target /home/node/.claude and /home/node/.aws.
# Do NOT change this to root without moving those mounts to /root.
USER node

ENTRYPOINT ["harness-entrypoint"]
CMD ["npm", "run", "start"]
