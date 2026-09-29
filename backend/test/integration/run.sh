#!/usr/bin/env bash
# Runs integration tests against a throwaway anvil node and the compose Postgres/Redis.
set -euo pipefail
cd "$(dirname "$0")/../.."
docker compose up -d >/dev/null
# compile contracts (NomaStaking artifact is deployed by the staking integration test)
( cd ../contracts && [ -d node_modules ] || npm install --no-audit --no-fund >/dev/null
  mkdir -p "$HOME/.svm-cache"
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$HOME/.svm-cache:/tmp/.svm" -v "$PWD:/w" -w /w     ghcr.io/foundry-rs/foundry:latest "forge build" >/dev/null )
docker compose exec -T postgres psql -U noma -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='noma_test'" </dev/null | grep -q 1 \
  || docker compose exec -T postgres psql -U noma -d postgres -qc "CREATE DATABASE noma_test" </dev/null
docker rm -f noma-anvil >/dev/null 2>&1 || true
docker run -d --name noma-anvil -p 127.0.0.1:58545:8545 ghcr.io/foundry-rs/foundry:latest "anvil --host 0.0.0.0" >/dev/null
trap 'docker rm -f noma-anvil >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 30); do
  curl -sf -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:58545 >/dev/null && break
  sleep 1
done
npx vitest run --config vitest.integration.config.ts "$@"
