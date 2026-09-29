# NOMA backend

Launch-scope API + workers. Design: `../architecture.md`, `../backend.md`.

## Run

```bash
cp .env.example .env              # fill ENCRYPTION_KEY (openssl rand -base64 32) and ADMIN_TOKEN
docker compose up -d              # postgres :55442, redis :56389
npm install
npm run migrate
npm run dev:api                   # http://localhost:3000
npm run dev:workers
npm test
```

Env is loaded from `.env` via `--env-file-if-exists` (Node ≥ 22.9).

## Layout

| Path | What |
|------|------|
| `src/api` | Fastify server + routes (catalog, orders, rewards/lookup/collection, agent, admin) |
| `src/modules/*` | Domain logic per module (backend.md §2) |
| `src/suppliers` | `SupplierAdapter` interface, registry, adapters |
| `src/workers/main.ts` | All BullMQ processors + repeatable schedules |
| `src/chain` | viem clients, ABIs, xpub deposit addresses, `sendOnce` |
| `migrations/` | Plain SQL, applied in order by `npm run migrate` |

## Invariants

- **Order key** is returned once by `POST /orders`; only its sha256 is stored.
- **Deposit addresses** are derived from `PAYMENT_XPUB`; the API never holds the payment private key.
- **Fund-moving txs** (refunds, claims, swaps, distributions) go through `sendOnce`: signed tx + hash are
  written to `chain_txs` before broadcast, so a crashed job resumes without double-sending.
- **Fulfillment** uses `idempotency_key = order id`; once a supplier order id is recorded, retries only poll.
- **Stock of the Week**: only the `active` cycle is ever returned by the API.
- **Distribution** computes snapshot + allocations every cycle; sending is gated by `AUTO_DISTRIBUTION_ENABLED`.

## Not done yet (TODO in code)

- Pons V2 ABIs/event signatures (`src/chain/abis`) — verify against deployed contracts.
- RewardVault contract itself, and swap routing/quotes in the executor (`quoteSwap` throws on purpose).
- ETH/USD price feed (`price:ETH` in Redis); native-ETH payer detection for refunds.
- Supplier adapters other than OpenRouter + mock eSIM.
- Overpayment refunds; late payments to expired invoices.
