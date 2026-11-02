#!/bin/sh
# Role dispatcher for the backend image. Environment comes from the container (env_file), never
# from a baked-in .env.
set -e
case "$1" in
  api) exec node dist/main.js ;;
  workers) exec node dist/workers/main.js ;;
  migrate) exec node dist/db/migrate.js ;;
  # healthchecks: the API answers /health; long-running workers touch a heartbeat file
  healthcheck-api) exec wget -qO- "http://127.0.0.1:${PORT:-3000}/health" >/dev/null ;;
  healthcheck-heartbeat)
    max="${2:-120}"
    [ -f /tmp/noma-heartbeat ] || exit 1
    age=$(( $(date +%s) - $(stat -c %Y /tmp/noma-heartbeat) ))
    [ "$age" -lt "$max" ] ;;
  *) exec "$@" ;;
esac
