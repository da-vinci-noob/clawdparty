#!/usr/bin/env bash
# Rails service entrypoint. Self-heals gems on lockfile drift, waits for
# postgres, then prepares all three databases (primary, Solid Queue, Solid
# Cable). The schema/migrations themselves are owned by `rails-foundation`;
# this entrypoint is the hook that runs them once postgres is healthy.
set -euo pipefail

cd /app

echo "[rails-entrypoint] bundle check || bundle install"
bundle check || bundle install

# Wait for postgres to accept connections. `depends_on: service_healthy` already
# gates on the pg_isready healthcheck, but this is the in-container belt-and-braces.
db_host="${DATABASE_HOST:-postgres}"
echo "[rails-entrypoint] waiting for ${db_host}:5432"
until nc -z "${db_host}" 5432; do
  sleep 0.5
done
echo "[rails-entrypoint] ${db_host}:5432 is up"

# Create + migrate all three logical databases. `db:prepare` is idempotent.
# Guarded so this entrypoint still works before rails-foundation lands the app:
# if there is no Rakefile/bin/rails yet, skip DB prep rather than hard-fail.
if [[ -f "bin/rails" || -f "Rakefile" ]]; then
  echo "[rails-entrypoint] bin/rails db:prepare (primary + queue + cable)"
  bin/rails db:prepare
else
  echo "[rails-entrypoint] no Rails app present yet — skipping db:prepare (rails-foundation not landed)"
fi

exec "$@"
