#!/usr/bin/env bash
# Runs the API and workers on the host, against the compose Postgres/Redis (dev/build server).
# Idempotent: stops any previous instances first. Used at boot from the ubuntu user's crontab.
set -euo pipefail
cd "$(dirname "$0")/.."

pkill -f '[d]ist/main.js' || true
pkill -f '[d]ist/workers/main.js' || true
sleep 2

nohup npm run start:api     > /home/ubuntu/noma-api.log     2>&1 &
nohup npm run start:workers > /home/ubuntu/noma-workers.log 2>&1 &
echo "noma api + workers started"
