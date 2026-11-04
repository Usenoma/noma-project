# NOMA frontend

Next.js 16 (App Router) + React 19 + Tailwind v4 site for NOMA. Design and page specs:
`../frontend.md`. Product/API contract: `../backend.md`.

## Run

```bash
npm install
npm run dev     # http://localhost:3101, proxies /api/* to API_ORIGIN (default :3000)
npm run build   # production build
npm run lint    # eslint (must stay clean)
```

`next.config.ts` rewrites `/api/:path*` to `API_ORIGIN` (same-origin, no CORS). Use
`NEXT_PUBLIC_API_URL` only when calling the API directly in local dev.

## Layout

| Path | What |
|---|---|
| `src/app` | routes: home, market, product, checkout, order(s), rewards, lookup, collection, agent, ghost, docs, status, admin/ops |
| `src/components` | shared UI (AgentChat, GhostChat/Vault/Receipt, InvoicePanel, FeatureCarousel, …) |
| `src/lib` | API client (`api.ts`), types, feature flags (`features.ts`), order/ghost keys, wagmi config |

## Notes

- **Feature flags** live in `src/lib/features.ts` (`NEXT_PUBLIC_FEATURE_*`, build-time). Gated
  routes must render a "not available yet" state when off — never 404 (frontend.md §11.5/11.6).
- **Wallet** is optional everywhere: `WalletScope` lazy-loads wagmi so light pages carry zero
  wallet bytes; the header button is two-stage and connects on the first click.
- **Keys stay client-side**: order keys live in the URL fragment; the ghost vault key is
  localStorage with explicit opt-in. Never log either.
- Static assets use cache headers from `next.config.ts`; brand media is content-busted with a
  version query when replaced.
