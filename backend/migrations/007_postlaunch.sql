-- Post-launch features (gated by frontend flags; no launch path depends on these tables).
-- Frontend: frontend.md §11. Backend: backend.md §15.

-- Ghost Checkout: per-order, per-supplier identity aliases (non-delivery fields only).
CREATE TABLE aliases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  supplier_id TEXT NOT NULL,
  field       TEXT NOT NULL,
  value       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ,
  UNIQUE (order_id, supplier_id, field)
);

-- Digital Capsules: bundles of services sold as one outcome.
CREATE TABLE capsules (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug    TEXT NOT NULL UNIQUE,
  title   TEXT NOT NULL,
  outcome TEXT NOT NULL,
  active  BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE capsule_items (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  capsule_id UUID NOT NULL REFERENCES capsules(id) ON DELETE CASCADE,
  category   TEXT NOT NULL,
  title      TEXT NOT NULL,
  position   INT NOT NULL DEFAULT 0
);
CREATE TABLE capsule_orders (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  capsule_id UUID NOT NULL REFERENCES capsules(id),
  order_id   UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Subscription Guardian.
CREATE TABLE subscriptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner        TEXT NOT NULL,
  service      TEXT NOT NULL,
  supplier_id  TEXT,
  renewal_at   TIMESTAMPTZ,
  price_usd    NUMERIC(12,2),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','expired')),
  last_seen_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_owner_idx ON subscriptions (owner);
CREATE TABLE subscription_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  data            JSONB NOT NULL DEFAULT '{}',
  ts              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed two capsules built from launch categories. The price is computed from the cheapest live
-- product per item, so a capsule is never cheaper by hiding a service.
INSERT INTO capsules (slug, title, outcome) VALUES
  ('travel-kit', 'Travel Kit', 'Stay connected and private abroad: mobile data for your destination plus a VPN for every network.'),
  ('private-workstation', 'Private Workstation', 'A server you control, reached through a private tunnel.');

INSERT INTO capsule_items (capsule_id, category, title, position)
  SELECT id, 'esim', 'eSIM — data for your destination', 0 FROM capsules WHERE slug = 'travel-kit';
INSERT INTO capsule_items (capsule_id, category, title, position)
  SELECT id, 'vpn', 'VPN — every server, 30 days', 1 FROM capsules WHERE slug = 'travel-kit';
INSERT INTO capsule_items (capsule_id, category, title, position)
  SELECT id, 'vps', 'VPS — 1 vCPU / 1 GB RAM / 25 GB SSD', 0 FROM capsules WHERE slug = 'private-workstation';
INSERT INTO capsule_items (capsule_id, category, title, position)
  SELECT id, 'vpn', 'VPN — every server, 30 days', 1 FROM capsules WHERE slug = 'private-workstation';
