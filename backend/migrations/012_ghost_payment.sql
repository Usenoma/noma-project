-- Ghost Payment v1: user-authorized spending budget for agent-originated purchases.
-- The agent can create an order from NOMA's catalog up to the budget; the user always pays
-- from their own wallet — the agent never holds a key or signs anything.

ALTER TABLE ghost_vaults ADD COLUMN budget_usd NUMERIC(12,2) NOT NULL DEFAULT 0;

CREATE TABLE ghost_purchases (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id   UUID NOT NULL REFERENCES ghost_vaults(id) ON DELETE CASCADE,
  mission_id UUID NOT NULL REFERENCES ghost_missions(id) ON DELETE CASCADE,
  order_id   UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  title      TEXT NOT NULL,
  price_usd  NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id)
);
CREATE INDEX ghost_purchases_vault_idx ON ghost_purchases (vault_id, created_at DESC);

-- The mission event trail gains a purchase kind (the receipt shows agent purchases).
ALTER TABLE ghost_mission_events DROP CONSTRAINT IF EXISTS ghost_mission_events_kind_check;
ALTER TABLE ghost_mission_events ADD CONSTRAINT ghost_mission_events_kind_check
  CHECK (kind IN ('search','fetch','permission_ask','permission_grant','permission_deny',
                  'alias_used','data_shared','present','purchase'));
