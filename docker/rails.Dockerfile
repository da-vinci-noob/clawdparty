# Ruby application image — used by BOTH the `rails` (Puma) and `jobs` (Solid
# Queue supervisor) services. Same image, different command.
FROM ruby:4.0.5-slim

# PostgreSQL client (pg gem build + psql) and a wait-for-postgres tool.
RUN apt-get update -qq \
  && apt-get install --no-install-recommends -y \
     build-essential \
     libpq-dev \
     postgresql-client \
     git \
     curl \
     netcat-openbsd \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Deps are installed at entrypoint time against the `bundle` named volume
# (see docker/entrypoints/rails.sh), not baked here — source is bind-mounted.
ENV BUNDLE_PATH=/usr/local/bundle

COPY docker/entrypoints/rails.sh /usr/local/bin/rails-entrypoint
RUN chmod +x /usr/local/bin/rails-entrypoint

ENTRYPOINT ["rails-entrypoint"]

# Default command: Puma bound to 0.0.0.0:3000 INSIDE the container. The LAN
# exposure comes solely from the single 3000:3000 publish on the `rails` service.
# The `jobs` service overrides this with `bin/jobs` in docker-compose.yml.
CMD ["bin/rails", "server", "-b", "0.0.0.0", "-p", "3000"]
