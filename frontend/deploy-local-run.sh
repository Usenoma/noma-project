#!/usr/bin/env bash
# Runs the NOMA frontend (Next.js) on the host, proxying /api to the API on 3100.
# Idempotent: stops any previous instance on port 3101 only (never other projects).
set -euo pipefail
cd "$(dirname "$0")/frontend"

if command -v fuser >/dev/null; then fuser -k 3101/tcp 2>/dev/null || true; fi
sleep 2

export API_ORIGIN=http://localhost:3100
nohup npm run start > /home/ubuntu/noma-frontend.log 2>&1 &
echo "noma frontend started"
