# Production deployment

One Docker image (`../Dockerfile`) runs every backend role: `api`, `workers`, `migrate`,
`sweeper`. `docker-compose.prod.yml` wires them with Postgres, Redis, Caddy (automatic HTTPS) and a
daily database backup.

## Files on the server (never committed)

| File | Content |
|------|---------|
| `compose.env` | Compose-level values, from `compose.env.example`: `DOMAIN`, `ACME_EMAIL`, `POSTGRES_PASSWORD`, ports, backup settings |
| `noma.env` | Application settings, from `../.env.example`. `DATABASE_URL`, `REDIS_URL`, `PORT` and `NODE_ENV` are set by compose and ignored here |
| `sweeper.env` | Sweeper only: `PAYMENT_XPRV`, `TREASURY_ADDRESS`, `SWEEPER_GAS_PRIVATE_KEY` |

`PAYMENT_XPRV` must never be in `noma.env`: the API and workers refuse to start with it in production.

## First start

```bash
cd backend/deploy
cp compose.env.example compose.env   # fill in; POSTGRES_PASSWORD: openssl rand -hex 24
cp ../.env.example noma.env          # fill in
docker compose -f docker-compose.prod.yml --env-file compose.env up -d --build
docker compose -f docker-compose.prod.yml --env-file compose.env ps
curl https://$DOMAIN/ready           # {"ok":true,"checks":{"db":"ok","redis":"ok","workers":"ok"}}
```

`migrate` runs once before `api` and `workers` on every `up`; they only start if it succeeded.
DNS for `DOMAIN` must point at the host and ports 80/443 must be open for the certificate.

## Deposit sweeper

Runs from the same image with its own env file, ideally on a separate host that can reach the same
Postgres and Redis (e.g. over WireGuard). On the same host:

```bash
docker compose -f docker-compose.prod.yml --env-file compose.env --profile sweeper up -d sweeper
docker compose -f docker-compose.prod.yml --env-file compose.env run --rm sweeper sweeper --once   # one pass
```

## Updates

```bash
git pull
NOMA_VERSION=$(git rev-parse --short HEAD) docker compose -f docker-compose.prod.yml --env-file compose.env up -d --build
```

Rollback: `NOMA_VERSION=<previous tag> docker compose ... up -d` (images stay tagged locally).
Migrations are forward-only, so a rollback across a migration needs a restore.

## Monitoring

- **Uptime:** point an external monitor (UptimeRobot, Better Stack, …) at `https://$DOMAIN/ready`.
  It returns 503 when Postgres, Redis or the workers heartbeat (< 2 min) is down, so it also catches
  a dead or hung workers process, which in-process alerts cannot report.
- **Alerts:** set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` and/or `ALERT_WEBHOOK_URL` in `noma.env`.
- **Container health:** `api` answers `/health`; `workers` and `sweeper` touch a heartbeat file.
  `restart: unless-stopped` restarts crashed processes; an unhealthy (hung) one is reported by the
  uptime monitor.
- **Logs:** JSON (pino), rotated by Docker (5 × 20 MB per container):
  `docker compose ... logs -f workers`.

## Backups

The `backup` service writes `pg_dump -Fc` to `BACKUP_DIR` daily and keeps `BACKUP_KEEP_DAYS`.
Copy that directory off the host (e.g. `rclone sync` to object storage from a host cron job).

Restore into a fresh database:

```bash
docker compose ... exec -T postgres psql -U noma -d postgres -c "CREATE DATABASE noma_restore"
docker run --rm --network noma-prod_default -e PGPASSWORD=... -v "$PWD/backups:/b:ro" \
  postgres:16-alpine pg_restore -h postgres -U noma -d noma_restore /b/noma-<timestamp>.dump
```

Verified 2026-09-29 on the build server (`DOMAIN=localhost`, Caddy internal CA): all services
healthy, `/ready` 503 while workers were stopped and 200 after restart, HSTS/nosniff headers set,
a restored backup matched the live database (5219 products, 6 migrations), and the API refused to
start with `PAYMENT_XPRV` set.

## Admin endpoints

`/admin/*` always requires `ADMIN_TOKEN`. `ADMIN_ALLOW_CIDR` in `compose.env` additionally limits
which source IPs Caddy lets through (default: all).
