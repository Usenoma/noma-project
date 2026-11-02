-- Ghost Agent: privacy-first research missions (backend.md §15.5, frontend.md §11.6).
-- Gated by FEATURE_GHOST_AGENT=1. The vault key is the only credential, like order keys.
-- Hard rule: real PII is never stored. Profiles hold synthetic aliases only; real values pass
-- through ephemeral, logged permission grants and are discarded immediately.

CREATE TABLE ghost_vaults (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash   TEXT NOT NULL UNIQUE,
  key_last4  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ghost Identity: one profile per activity. Aliases only, never real values.
CREATE TABLE ghost_profiles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id    UUID NOT NULL REFERENCES ghost_vaults(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email_alias TEXT NOT NULL,
  aliases     JSONB NOT NULL DEFAULT '{}',
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ghost_profiles_vault_idx ON ghost_profiles (vault_id);

-- Privacy Router rules: per field, share a synthetic alias or refuse entirely.
-- 'real' is deliberately not a stored mode — real values only enter via ephemeral grants.
CREATE TABLE ghost_rules (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id   UUID NOT NULL REFERENCES ghost_vaults(id) ON DELETE CASCADE,
  field      TEXT NOT NULL,
  mode       TEXT NOT NULL CHECK (mode IN ('alias', 'deny')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vault_id, field)
);

-- Missions. `state` holds the in-flight LLM message history plus a pending permission
-- request so a zero-trust approval can be resolved on the next chat call.
CREATE TABLE ghost_missions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id   UUID NOT NULL REFERENCES ghost_vaults(id) ON DELETE CASCADE,
  profile_id UUID REFERENCES ghost_profiles(id) ON DELETE SET NULL,
  status     TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed','cancelled')),
  title      TEXT,
  state      JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ghost_missions_vault_idx ON ghost_missions (vault_id, created_at DESC);

CREATE TABLE ghost_mission_messages (
  id         BIGSERIAL PRIMARY KEY,
  mission_id UUID NOT NULL REFERENCES ghost_missions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ghost_mission_messages_mission_idx ON ghost_mission_messages (mission_id, id);

-- Ghost Receipt data source: every search, fetch, permission decision and shared field.
CREATE TABLE ghost_mission_events (
  id         BIGSERIAL PRIMARY KEY,
  mission_id UUID NOT NULL REFERENCES ghost_missions(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('search','fetch','permission_ask','permission_grant',
                                           'permission_deny','alias_used','data_shared','present')),
  detail     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ghost_mission_events_mission_idx ON ghost_mission_events (mission_id, id);
