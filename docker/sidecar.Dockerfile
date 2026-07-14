# Sidecar image — Node 24 (pinned; the host runs Node 25, but the container
# runtime is deterministic). Runs the Fastify server wrapping the Agent SDK.
FROM node:24-slim

# git is required: the sidecar runs git inside the bind-mounted target repo's
# worktrees (created by the root `rails` service).
RUN apt-get update -qq \
  && apt-get install --no-install-recommends -y git curl \
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

COPY docker/entrypoints/sidecar.sh /usr/local/bin/sidecar-entrypoint
RUN chmod +x /usr/local/bin/sidecar-entrypoint

# Run as the non-root `node` user shipped by the base image (home /home/node).
# Load-bearing: the SDK resolves ~/.claude and ~/.aws via `~`, so the credential
# mounts in docker-compose.yml target /home/node/.claude and /home/node/.aws.
# Do NOT change this to root without moving those mounts to /root.
USER node

ENTRYPOINT ["sidecar-entrypoint"]
CMD ["npm", "run", "start"]
