-- Eligibility changes from holding to staking (NomaStaking). Rewards are claim-based:
-- the executor streams them into NomaStaking; there is no push distribution or snapshot.

DROP TABLE IF EXISTS distributions;
DROP TABLE IF EXISTS genesis_holders;
DROP TABLE IF EXISTS snapshot_balances;
DROP TABLE IF EXISTS snapshots;
DROP TABLE IF EXISTS noma_balances;

-- Current staking position per wallet (indexed from NomaStaking events)
CREATE TABLE stakes (
  address         TEXT PRIMARY KEY,
  staked_amount   NUMERIC(78,0) NOT NULL DEFAULT 0,
  pending_unstake NUMERIC(78,0) NOT NULL DEFAULT 0,
  unlock_at       TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stakes_active_idx ON stakes (address) WHERE staked_amount > 0;

-- Raw staking history: needed for GENESIS (who staked during week 1) and audit
CREATE TABLE staking_events (
  tx_hash      TEXT NOT NULL,
  log_index    INTEGER NOT NULL,
  block        BIGINT NOT NULL,
  ts           TIMESTAMPTZ NOT NULL,
  address      TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('stake', 'unstake_request', 'withdraw')),
  amount       NUMERIC(78,0) NOT NULL,
  staked_after NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX staking_events_address_idx ON staking_events (address, ts);

-- One row per NomaStaking.notifyReward (RewardAdded)
CREATE TABLE reward_notifications (
  id            BIGSERIAL PRIMARY KEY,
  cycle_id      INTEGER REFERENCES reward_cycles(id),
  asset         TEXT NOT NULL,              -- symbol: 'ZEC' or the week's stock symbol
  asset_address TEXT NOT NULL,
  amount        NUMERIC(78,0) NOT NULL,
  amount_usd    NUMERIC(20,6),
  stream_end    TIMESTAMPTZ NOT NULL,
  tx_hash       TEXT NOT NULL,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tx_hash, asset_address)
);
CREATE INDEX reward_notifications_asset_idx ON reward_notifications (asset_address, ts);

CREATE TABLE claims (
  id            BIGSERIAL PRIMARY KEY,
  address       TEXT NOT NULL,
  asset         TEXT NOT NULL,
  asset_address TEXT NOT NULL,
  amount        NUMERIC(78,0) NOT NULL,
  amount_usd    NUMERIC(20,6),
  tx_hash       TEXT NOT NULL,
  log_index     INTEGER NOT NULL,
  ts            TIMESTAMPTZ NOT NULL,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX claims_address_idx ON claims (address);

-- Cumulative reward accrued per wallet and asset (earned + claimed) read on-chain at each
-- cycle end. The difference between consecutive checkpoints is what the wallet received from
-- the stream that just ended; collection_entries are built from these deltas.
CREATE TABLE reward_checkpoints (
  cycle_id      INTEGER NOT NULL REFERENCES reward_cycles(id),
  block         BIGINT NOT NULL,
  address       TEXT NOT NULL,
  asset_address TEXT NOT NULL,
  cumulative    NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (cycle_id, address, asset_address)
);

-- GENESIS: wallets that staked at any time during the week-1 cycle
CREATE TABLE genesis_holders (
  address   TEXT PRIMARY KEY,
  cycle_id  INTEGER NOT NULL REFERENCES reward_cycles(id),
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
