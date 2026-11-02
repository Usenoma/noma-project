import { randomBytes } from "node:crypto";
import { db } from "../../db/pool.js";
import { notFound } from "../../lib/errors.js";

/**
 * Ghost Identity: one profile per activity. Profiles hold synthetic aliases only — real values
 * are never stored. Aliases are placeholders for signup forms that do not verify.
 */

export interface GhostProfile {
  id: string;
  name: string;
  email_alias: string;
  aliases: Record<string, string>;
  active: boolean;
}

/** Fields a profile can alias (email lives in its own column; the rest in `aliases` JSONB). */
const ALIAS_FIELDS = ["name", "phone", "address"] as const;

export function generateAliases(tag: string): { email_alias: string; aliases: Record<string, string> } {
  return {
    email_alias: `ghost-${tag}@noma.alias`,
    aliases: Object.fromEntries(ALIAS_FIELDS.map((f) => [f, `noma-ghost-${tag}-${f}`])),
  };
}

const PROFILE_COLS = "id, name, email_alias, aliases, active";

export async function listProfiles(vaultId: string): Promise<GhostProfile[]> {
  const { rows } = await db.query<GhostProfile>(
    `SELECT ${PROFILE_COLS} FROM ghost_profiles WHERE vault_id = $1 ORDER BY created_at`,
    [vaultId],
  );
  return rows;
}

export async function createProfile(vaultId: string, name: string): Promise<GhostProfile> {
  const { email_alias, aliases } = generateAliases(randomBytes(3).toString("hex"));
  const { rows } = await db.query<GhostProfile>(
    `INSERT INTO ghost_profiles (vault_id, name, email_alias, aliases)
     VALUES ($1, $2, $3, $4) RETURNING ${PROFILE_COLS}`,
    [vaultId, name, email_alias, aliases],
  );
  return rows[0]!;
}

export async function updateProfile(vaultId: string, id: string, name: string): Promise<GhostProfile> {
  const { rows } = await db.query<GhostProfile>(
    `UPDATE ghost_profiles SET name = $3, updated_at = now()
     WHERE id = $1 AND vault_id = $2 RETURNING ${PROFILE_COLS}`,
    [id, vaultId, name],
  );
  const profile = rows[0];
  if (!profile) throw notFound("profile");
  return profile;
}

export async function deleteProfile(vaultId: string, id: string): Promise<void> {
  const res = await db.query("DELETE FROM ghost_profiles WHERE id = $1 AND vault_id = $2", [id, vaultId]);
  if (res.rowCount === 0) throw notFound("profile");
}

/** The profile a new mission starts with: the oldest active one. */
export async function activeProfile(vaultId: string): Promise<GhostProfile | null> {
  const { rows } = await db.query<GhostProfile>(
    `SELECT ${PROFILE_COLS} FROM ghost_profiles WHERE vault_id = $1 AND active = true ORDER BY created_at LIMIT 1`,
    [vaultId],
  );
  return rows[0] ?? null;
}

/** Alias lookup for a field (email comes from the dedicated column). */
export function aliasFor(profile: GhostProfile | null, field: string): string | null {
  if (!profile) return null;
  if (field === "email") return profile.email_alias;
  return profile.aliases[field] ?? null;
}
