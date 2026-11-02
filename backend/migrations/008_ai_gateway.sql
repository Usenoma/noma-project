-- AI gateway: NOMA-issued API keys, prepaid usage, and a per-request ledger.
-- The OpenRouter key never leaves the backend; the buyer only ever holds a NOMA key.

CREATE TABLE ai_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  key_hash      TEXT NOT NULL UNIQUE,
  key_encrypted TEXT NOT NULL,
  key_last4     TEXT NOT NULL,
  credit_usd    NUMERIC(20,6) NOT NULL,
  used_usd      NUMERIC(20,6) NOT NULL DEFAULT 0,
  reserved_usd  NUMERIC(20,6) NOT NULL DEFAULT 0,
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_usage (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id              UUID NOT NULL REFERENCES ai_keys(id) ON DELETE CASCADE,
  order_id            UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  model               TEXT NOT NULL,
  reserved_usd        NUMERIC(20,8) NOT NULL DEFAULT 0,
  prompt_tokens       INT,
  completion_tokens   INT,
  openrouter_cost_usd NUMERIC(20,8),
  retail_cost_usd     NUMERIC(20,8),
  generation_id       TEXT,
  status              TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','settled','failed')),
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at          TIMESTAMPTZ
);

CREATE INDEX ai_usage_key_created_idx ON ai_usage (key_id, created_at DESC);
CREATE INDEX ai_usage_order_idx ON ai_usage (order_id);
