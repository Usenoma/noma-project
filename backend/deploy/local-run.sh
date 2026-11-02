#!/usr/bin/env bash
# Runs the API and workers on the host, against the compose Postgres/Redis (dev/build server).
# Idempotent: stops only NOMA processes whose cwd is this backend directory. Used at boot from
# the ubuntu user's crontab.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd -P)"

stop_in_root() {
  local pattern="$1"
  local pid
  for pid in $(pgrep -f "$pattern" || true); do
    if [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)" = "$ROOT" ]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}
stop_in_root 'node --env-file-if-exists=.env dist/main.js'
stop_in_root 'node --env-file-if-exists=.env dist/workers/main.js'
sleep 2

nohup npm run start:api     > /home/ubuntu/noma-api.log     2>&1 &
nohup npm run start:workers > /home/ubuntu/noma-workers.log 2>&1 &
echo "noma api + workers started"
