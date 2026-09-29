-- NOMA initial schema (launch scope). See backend.md §3.
-- On-chain amounts are raw token units as NUMERIC(78,0); USD values as NUMERIC(20,6).

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Last processed block per chain indexer (payment-watcher, reward-indexer, ...)
CREATE TABLE indexer_cursors (
  name       TEXT PRIMARY KEY,
  block      BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every fund-moving tx is recorded here BEFORE broadcast, keyed by purpose, so a crashed job
-- resumes by checking the recorded hash instead of sending again.
CREATE TABLE chain_txs (
  purpose    TEXT PRIMARY KEY,                    -- e.g. 'refund:<order>', 'swap:<cycle>:ZEC'
  tx_hash    TEXT NOT NULL,
  raw_tx     TEXT NOT NULL,                       -- signed tx, re-broadcastable if it never landed
  status     TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'success', 'reverted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── CATALOG ──────────────────────────────────────────────────────────────
CREATE TABLE suppliers (
  id                TEXT PRIMARY KEY,               -- adapter id, e.g. 'esimaccess'
  name              TEXT NOT NULL,
  category          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  balance_usd       NUMERIC(20,6),
  balance_alert_usd NUMERIC(20,6),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id     TEXT NOT NULL REFERENCES suppliers(id),
  supplier_sku    TEXT NOT NULL,
  category        TEXT NOT NULL CHECK (category IN ('esim', 'ai_credits', 'vpn', 'proxy', 'vps', 'giftcard')),
  title           TEXT NOT NULL,
  region          TEXT,
  specs           JSONB NOT NULL DEFAULT '{}',
  cost_usd        NUMERIC(20,6) NOT NULL,
  price_usd       NUMERIC(20,6) NOT NULL,
  required_fields JSONB NOT NULL DEFAULT '[]',
  active          BOOLEAN NOT NULL DEFAULT true,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, supplier_sku)
);
CREATE INDEX products_browse_idx ON products (category, region) WHERE active;
CREATE INDEX products_title_fts_idx ON products USING gin (to_tsvector('simple', title));

-- ─── ORDERS ───────────────────────────────────────────────────────────────
CREATE TABLE orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id       UUID NOT NULL REFERENCES products(id),
  order_key_hash   TEXT NOT NULL,
  wallet_address   TEXT,
  customer_fields  TEXT,                            -- encrypted JSON
  price_usd        NUMERIC(20,6) NOT NULL,
  status           TEXT NOT NULL CHECK (status IN (
                     'created', 'awaiting_payment', 'paid', 'fulfilling', 'delivered',
                     'expired', 'failed', 'refunding', 'refunded')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_wallet_idx ON orders (lower(wallet_address)) WHERE wallet_address IS NOT NULL;

CREATE SEQUENCE invoice_address_index_seq;

CREATE TABLE invoices (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       UUID NOT NULL UNIQUE REFERENCES orders(id),
  chain          TEXT NOT NULL,
  asset          TEXT NOT NULL,                     -- 'USDC' | 'ETH'
  amount         NUMERIC(78,0) NOT NULL,            -- raw units
  pay_to         TEXT NOT NULL,                     -- unique derived deposit address
  address_index  BIGINT NOT NULL UNIQUE,
  payment_ref    TEXT NOT NULL UNIQUE,
  expires_at     TIMESTAMPTZ NOT NULL,
  tx_hash        TEXT,
  payer_address  TEXT,
  received       NUMERIC(78,0) NOT NULL DEFAULT 0,
  confirmations  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                   'pending', 'seen', 'confirmed', 'underpaid', 'expired')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX invoices_open_idx ON invoices (status) WHERE status IN ('pending', 'seen', 'underpaid');

CREATE TABLE fulfillments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          UUID NOT NULL REFERENCES orders(id),
  supplier_id       TEXT NOT NULL REFERENCES suppliers(id),
  idempotency_key   TEXT NOT NULL UNIQUE,
  attempt           INTEGER NOT NULL DEFAULT 0,
  supplier_order_id TEXT,
  request           JSONB,
  response          JSONB,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE deliverables (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          UUID NOT NULL UNIQUE REFERENCES orders(id),
  type              TEXT NOT NULL CHECK (type IN (
                      'esim_lpa', 'vps_credentials', 'vpn_config', 'proxy_credentials', 'giftcard_code', 'api_key')),
  payload_encrypted TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refunds (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID NOT NULL UNIQUE REFERENCES orders(id),
  amount     NUMERIC(78,0) NOT NULL,
  asset      TEXT NOT NULL,
  to_address TEXT NOT NULL,
  tx_hash    TEXT,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'confirmed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── REWARDS ──────────────────────────────────────────────────────────────
CREATE TABLE reward_cycles (
  id                  SERIAL PRIMARY KEY,
  week_no             INTEGER NOT NULL UNIQUE,
  stock_symbol        TEXT NOT NULL,
  stock_token_address TEXT,
  revealed_at         TIMESTAMPTZ,
  starts_at           TIMESTAMPTZ NOT NULL,
  ends_at             TIMESTAMPTZ NOT NULL,
  status              TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN (
                        'upcoming', 'active', 'executing', 'distributed'))
);
CREATE UNIQUE INDEX reward_cycles_one_active ON reward_cycles ((true)) WHERE status = 'active';

CREATE TABLE fee_accruals (
  id                       BIGSERIAL PRIMARY KEY,
  cycle_id                 INTEGER REFERENCES reward_cycles(id),
  source                   TEXT NOT NULL CHECK (source IN ('pons_curve', 'pons_v4_hook')),
  tx_hash                  TEXT NOT NULL,
  log_index                INTEGER NOT NULL,
  block                    BIGINT NOT NULL,
  trader                   TEXT NOT NULL,
  side                     TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  quote_asset              TEXT NOT NULL,
  trade_quote_amount       NUMERIC(78,0) NOT NULL,
  creator_tax_amount       NUMERIC(78,0) NOT NULL,
  creator_fee_share_amount NUMERIC(78,0) NOT NULL DEFAULT 0,
  amount_usd               NUMERIC(20,6),
  ts                       TIMESTAMPTZ NOT NULL,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX fee_accruals_cycle_idx ON fee_accruals (cycle_id);

CREATE TABLE escrow_claims (
  id          BIGSERIAL PRIMARY KEY,
  cycle_id    INTEGER NOT NULL REFERENCES reward_cycles(id),
  quote_asset TEXT NOT NULL,
  amount      NUMERIC(78,0) NOT NULL,
  amount_usd  NUMERIC(20,6),
  tx_hash     TEXT NOT NULL UNIQUE,
  ts          TIMESTAMPTZ NOT NULL
);

CREATE TABLE reward_acquisitions (
  id         BIGSERIAL PRIMARY KEY,
  cycle_id   INTEGER NOT NULL REFERENCES reward_cycles(id),
  asset      TEXT NOT NULL CHECK (asset IN ('ZEC', 'STOCK')),
  amount_in  NUMERIC(78,0) NOT NULL,
  amount_out NUMERIC(78,0) NOT NULL,
  usd_value  NUMERIC(20,6),
  tx_hash    TEXT NOT NULL UNIQUE,
  ts         TIMESTAMPTZ NOT NULL
);

-- $NOMA holder balances, maintained by reward-indexer from Transfer events (source for snapshots)
CREATE TABLE noma_balances (
  address    TEXT PRIMARY KEY,
  balance    NUMERIC(78,0) NOT NULL,
  updated_block BIGINT NOT NULL
);
CREATE INDEX noma_balances_positive_idx ON noma_balances (address) WHERE balance > 0;

CREATE TABLE snapshots (
  id                  SERIAL PRIMARY KEY,
  cycle_id            INTEGER NOT NULL UNIQUE REFERENCES reward_cycles(id),
  block               BIGINT NOT NULL,
  methodology_version TEXT NOT NULL,
  eligible_supply     NUMERIC(78,0) NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE snapshot_balances (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  address     TEXT NOT NULL,
  balance     NUMERIC(78,0) NOT NULL,
  eligible    BOOLEAN NOT NULL,
  PRIMARY KEY (snapshot_id, address)
);

CREATE TABLE distributions (
  id        BIGSERIAL PRIMARY KEY,
  cycle_id  INTEGER NOT NULL REFERENCES reward_cycles(id),
  address   TEXT NOT NULL,
  asset     TEXT NOT NULL CHECK (asset IN ('ZEC', 'STOCK')),
  amount    NUMERIC(78,0) NOT NULL,
  usd_value NUMERIC(20,6),
  tx_hash   TEXT,
  status    TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'confirmed', 'failed')),
  UNIQUE (cycle_id, address, asset)
);
CREATE INDEX distributions_address_idx ON distributions (address);

-- ─── COLLECTION ───────────────────────────────────────────────────────────
CREATE TABLE collection_entries (
  address      TEXT NOT NULL,
  cycle_id     INTEGER NOT NULL REFERENCES reward_cycles(id),
  asset_symbol TEXT NOT NULL,
  amount       NUMERIC(78,0) NOT NULL,
  usd_value    NUMERIC(20,6),
  tx_hash      TEXT NOT NULL,
  PRIMARY KEY (address, cycle_id, asset_symbol)
);

CREATE TABLE genesis_holders (
  address     TEXT PRIMARY KEY,
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id)
);

-- ─── AGENT ────────────────────────────────────────────────────────────────
CREATE TABLE agent_sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_messages (
  id         BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES agent_sessions(id),
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_messages_session_idx ON agent_messages (session_id, id);

INSERT INTO settings (key, value) VALUES
  ('markup_pct', '{"default": 0.08}');
