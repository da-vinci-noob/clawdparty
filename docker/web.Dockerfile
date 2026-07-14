# Web / Vite dev image — Node 24 (pinned; the host runs Node 25). Dev-only:
# runs the Vite dev server. In production-style serving the built SPA is served
# by `rails` directly, so this service is not needed there.
FROM node:24-slim

RUN apt-get update -qq \
  && apt-get install --no-install-recommends -y curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pre-create the node_modules mountpoint owned by `node` so the fresh named
# volume inherits `node` ownership (see sidecar.Dockerfile for the rationale).
RUN mkdir -p /app/node_modules && chown -R node:node /app

COPY docker/entrypoints/web.sh /usr/local/bin/web-entrypoint
RUN chmod +x /usr/local/bin/web-entrypoint

USER node

ENTRYPOINT ["web-entrypoint"]
CMD ["npm", "run", "dev"]
