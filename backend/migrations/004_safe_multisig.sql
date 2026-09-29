-- Reward Engine funds live in a Safe multisig (Pons creator fee recipient + NomaStaking EXECUTOR).
-- The executor only proposes Safe batches; owners sign and execute them in Safe{Wallet}.

CREATE TABLE safe_proposals (
  id                 BIGSERIAL PRIMARY KEY,
  cycle_id           INTEGER NOT NULL REFERENCES reward_cycles(id),
  kind               TEXT NOT NULL CHECK (kind IN ('claim', 'swap', 'fund_staking')),
  safe_tx_hash       TEXT NOT NULL UNIQUE,
  nonce              BIGINT NOT NULL,
  calls              JSONB NOT NULL,          -- human-readable summary of the batch
  status             TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'executed', 'failed')),
  execution_tx_hash  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- at most one live (non-failed) proposal per cycle step; a failed one can be re-proposed
CREATE UNIQUE INDEX safe_proposals_live_idx ON safe_proposals (cycle_id, kind) WHERE status <> 'failed';

-- both swaps may be executed in one Safe batch (same tx hash): one acquisition per cycle and asset
ALTER TABLE reward_acquisitions DROP CONSTRAINT reward_acquisitions_tx_hash_key;
ALTER TABLE reward_acquisitions ADD CONSTRAINT reward_acquisitions_cycle_asset_key UNIQUE (cycle_id, asset);
