-- P1 transaction corrections: buyer-reported payments, AI key rotation audit, capsule groups,
-- and subscription→order linkage.

-- A buyer can report a transfer that the exact-amount watcher could not match (wrong amount,
-- wrong asset, wrong invoice). Admins resolve it manually; nothing is credited automatically.
CREATE TABLE payment_claims (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  tx_hash       TEXT NOT NULL,
  asset         TEXT NOT NULL,
  amount        NUMERIC(78,0) NOT NULL,
  payer_address TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','rejected')),
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  UNIQUE (order_id, tx_hash)
);
CREATE INDEX payment_claims_status_idx ON payment_claims (status, created_at);

-- AI key rotation is auditable; usage rows reserved by a crashed request are reaped by the worker.
ALTER TABLE ai_keys ADD COLUMN rotated_at TIMESTAMPTZ;
CREATE INDEX ai_usage_reserved_created_idx ON ai_usage (created_at) WHERE status = 'reserved';

-- A capsule purchase creates one order per item; group_id ties those orders together.
ALTER TABLE capsule_orders ADD COLUMN group_id UUID;
UPDATE capsule_orders SET group_id = gen_random_uuid() WHERE group_id IS NULL;
ALTER TABLE capsule_orders ALTER COLUMN group_id SET NOT NULL;
CREATE INDEX capsule_orders_group_idx ON capsule_orders (group_id);

-- Subscription Guardian: link the record to the purchase/order it came from.
ALTER TABLE subscriptions ADD COLUMN order_id UUID REFERENCES orders(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX subscriptions_order_unique ON subscriptions (order_id) WHERE order_id IS NOT NULL;
