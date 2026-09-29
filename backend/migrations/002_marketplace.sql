-- Marketplace: overpayment refunds, late payments, time-limited resources.

-- 'late_paid': funds arrived after the invoice expired (or an underpayment was never completed);
-- the received amount is refunded and the invoice is closed.
ALTER TABLE invoices DROP CONSTRAINT invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check CHECK (status IN (
  'pending', 'seen', 'confirmed', 'underpaid', 'expired', 'late_paid'));

-- An order can have a full refund (failed / expired-then-paid) and, independently,
-- a refund of the amount paid above the invoice.
ALTER TABLE refunds ADD COLUMN kind TEXT NOT NULL DEFAULT 'full' CHECK (kind IN ('full', 'overpayment'));
ALTER TABLE refunds DROP CONSTRAINT refunds_order_id_key;
ALTER TABLE refunds ADD CONSTRAINT refunds_order_kind_key UNIQUE (order_id, kind);

CREATE INDEX invoices_expired_recent_idx ON invoices (expires_at) WHERE status = 'expired';

-- Time-limited supplier resources (e.g. 30-day VPS). The expiry job releases them at the supplier.
CREATE TABLE supplier_resources (
  order_id          UUID PRIMARY KEY REFERENCES orders(id),
  supplier_id       TEXT NOT NULL REFERENCES suppliers(id),
  supplier_order_id TEXT NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  released_at       TIMESTAMPTZ
);
CREATE INDEX supplier_resources_due_idx ON supplier_resources (expires_at) WHERE released_at IS NULL;

-- multi-country eSIM packages list their countries in specs.countries
CREATE INDEX products_countries_idx ON products USING gin ((specs -> 'countries'));

-- chain head when the invoice was created: lower bound when searching for the payment (native ETH payer lookup)
ALTER TABLE invoices ADD COLUMN start_block BIGINT;
