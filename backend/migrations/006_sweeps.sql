-- Deposit sweeps: funds received on per-invoice deposit addresses are moved to the treasury by the
-- separate sweeper process (the only holder of the xprv). Transactions go through chain_txs
-- (sendOnce) under the purposes 'sweep:<invoice>:<round>' and 'sweep-gas:<invoice>:<round>'.

CREATE TABLE sweeps (
  id           BIGSERIAL PRIMARY KEY,
  invoice_id   UUID NOT NULL REFERENCES invoices(id),
  round        INTEGER NOT NULL,                -- 1 for the first sweep of an address
  asset        TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address   TEXT NOT NULL,
  amount       NUMERIC(78,0),                   -- as actually transferred (set when swept)
  gas_topup    NUMERIC(78,0) NOT NULL DEFAULT 0, -- ETH sent to the deposit address for a token sweep
  tx_hash      TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'swept')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, round)
);
