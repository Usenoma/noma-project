-- Buyer vault: the wallet order list reads orders attached to the wallet and orders paid by it.
-- orders_wallet_idx already indexes lower(wallet_address); the payer side needs its own index.

CREATE INDEX IF NOT EXISTS invoices_payer_lower_idx
  ON invoices (lower(payer_address))
  WHERE payer_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS orders_created_at_idx
  ON orders (created_at DESC);
