# NOMA

**Give AI power. Not your privacy.**

NOMA is a privacy-first commerce layer on Robinhood Chain: buy digital services with crypto
(eSIM, VPS, AI credits, gift cards), delegate research and tasks to an AI agent under explicit
privacy rules, and keep control of identity, data and permissions. No accounts — an order key or
a wallet signature is the credential.

## Repository layout

| Path | What |
|---|---|
| `architecture.md` | Launch scope, system overview, flows |
| `backend.md` | Backend design, data model, endpoints, config, changelog (of record for features) |
| `frontend.md` | Design language, information architecture, pages, gated features, deployment notes |
| `backend/` | Fastify + TypeScript API, BullMQ workers, migrations, integration tests |
| `frontend/` | Next.js 16 App Router site (Tailwind v4, wagmi/viem) |
| `contracts/` | Foundry contracts: `NomaStaking`, deployment scripts, security review |
| `backend/deploy/` | Production image/compose, host runner scripts, backup + uptime monitoring |

## Quick start (local)

Prerequisites: Node 22+, Docker (Postgres + Redis), npm.

```bash
# backend
cd backend
cp .env.example .env                  # fill DATABASE_URL/REDIS_URL/ENCRYPTION_KEY/ADMIN_TOKEN
docker compose up -d postgres redis   # local infra
npm install
npm run migrate
npm run dev:api                       # API on :3000
npm run dev:workers                   # background jobs

# frontend
cd ../frontend
npm install
npm run dev                           # site on :3101, proxies /api to the backend
```

Tests: `cd backend && npm test` (unit, no infra) and `npm run test:integration`
(needs Docker + anvil; runs against a throwaway database).

## Features

**Live:** market/catalog, checkout with wallet-or-key payment (wallet-to-wallet, no custody),
order vault, AI gateway (NOMA keys proxying OpenRouter with a reserve/settle ledger), shopping
agent, Ghost Agent (privacy-first web research, zero-trust permissions, Ghost Receipt, budgeted
Ghost Payment with per-purchase confirmation), reward engine / lookup / collection endpoints
(populate once `$NOMA` + `NomaStaking` exist on-chain).

**Gated post-launch (flags off by default):** Ghost Checkout, Digital Capsules, Exposure Receipt,
Subscription Guardian. See `frontend.md §11` for the gating rules.

## Deployment

Production runs on the build server as a host process behind a shared Caddy edge
(`https://usenoma.org`). See `frontend.md §10` and `backend/deploy/README.md`; host-level backup
and uptime scripts live in `backend/deploy/` and run from the server crontab.

## Security

- Real PII is never stored by the Ghost Agent: profiles hold synthetic aliases only; approved
  real values are logged as shared (field only) and discarded.
- The API binds `HOST=127.0.0.1` on public servers (the frontend proxies `/api` over localhost).
- Ghost vault keys and order keys are hashed at rest and redacted from logs.
- Page fetches are SSRF-guarded on every redirect hop; the agent cannot buy outside NOMA's
  catalog and every purchase needs explicit user confirmation.
