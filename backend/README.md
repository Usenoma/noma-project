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
npm run test:integration        # anvil (docker) + test USDC: payment/refund flows on a real chain
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
- **Fund-moving txs** (refunds) go through `sendOnce`: signed tx + hash are
  written to `chain_txs` before broadcast, so a crashed job resumes without double-sending.
- **Fulfillment** uses `idempotency_key = order id`; once a supplier order id is recorded, retries only poll.
  A supplier that is still working is re-checked without using up retries and never refunded
  automatically; after `FULFILLMENT_PENDING_ALERT_MINUTES` (60) an alert asks a human to resolve it.
- **Stock of the Week**: only the `active` cycle is ever returned by the API.
- **Reward funds live in a Safe multisig**: the executor only proposes Safe transactions (delegate key) and
  waits for the owners to sign and execute them; `GET /admin/cycles/:id` shows the next action.
- **Rewards are staking-based**: only $NOMA staked in NomaStaking (`../contracts`) earns. The executor streams
  each cycle's ZEC + Stock Token into NomaStaking; stakers claim. Collection entries come from per-cycle
  on-chain checkpoints (`earned + totalClaimed`), GENESIS = wallets staked during week 1.

## Suppliers

| Adapter | Credentials env | Notes |
|---------|-----------------|-------|
| eSIM Access | `ESIMACCESS_KEY=<accessCode>:<secret>` | HMAC-signed; `transactionId` = order id (idempotent); no sandbox |
| Bitrefill | `BITREFILL_KEY=<apiId>:<secret>` (Business) or `<apiKey>` (Personal), `BITREFILL_COUNTRIES` | unpaid invoice first, paid from `status()` (no idempotency key); catalog every 6 h |
| BitLaunch | `BITLAUNCH_KEY` | 30-day VPS; server name `noma-<order>` as dedup key; `resource-expiry` deletes it |
| OpenRouter | `OPENROUTER_PROVISIONING_KEY` | provisioned API key with credit limit, returned at purchase |
| VPNresellers | `VPNRESELLERS_KEY`, `VPNRESELLERS_MONTHLY_USD` | one account per order with a supplier-side expiry; tested against fakes only |
| IPRoyal | `IPROYAL_KEY` | residential sub-user per order; static ISP/datacenter proxies not offered yet |

**Webhooks** (optional, need `PUBLIC_API_URL`): a supplier notification only makes the order's
status be re-read right away through the supplier API; the payload is never trusted and polling keeps
working without it. Bitrefill gets a per-invoice URL automatically. For eSIM Access, register the URL
from `GET /admin/webhooks` in their console. The URL contains a secret: treat it like a key.

## Payments

- ETH/USD from Coinbase + Kraken (needs both, <2% apart); stale price (>120 s) disables ETH checkout.
- Overpayment ≥ `OVERPAY_REFUND_MIN_USD` is refunded; late payments and underpayments not topped up
  within 24 h after expiry are refunded in full. Payer = ERC-20 Transfer sender, or for native ETH the
  sender found by binary-searching the deposit balance.

## Not done yet

Full list with what blocks each item: `../backend.md` §14.

- Automated 50/50 swap proposals (DEX routing on Robinhood Chain); today the Safe owners swap and an admin
  records it via `POST /admin/cycles/:id/acquisitions`. A RewardVault contract may later replace the Safe.
- IPRoyal static ISP/datacenter proxies (credential format undocumented: needs one real order).
- OpenRouter: resale terms and request/response shapes unconfirmed (no key yet).
- No real supplier purchase or mainnet payment has been run yet.
