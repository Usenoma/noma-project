import { createHash, randomBytes } from "node:crypto";
import { db, tx } from "../../db/pool.js";
import { generateAliases, listProfiles, type GhostProfile } from "./profiles.js";
import { DEFAULT_RULES, getRules, type GhostRules } from "./rules.js";

/**
 * Ghost vault: the anonymous container for profiles, rules and missions. The vault key is the
 * only credential (like an order key); only its hash is stored.
 */

export const GHOST_KEY_PREFIX = "noma_gv_";

export interface GhostVault {
  id: string;
  keyLast4: string;
  budgetUsd: number;
  createdAt: Date;
}

export function hashGhostKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function validGhostKey(key: string): boolean {
  return key.startsWith(GHOST_KEY_PREFIX) && key.length >= GHOST_KEY_PREFIX.length + 32;
}

export interface GhostVaultCreated {
  vault_key: string;
  key_last4: string;
  profiles: GhostProfile[];
  rules: GhostRules;
}

/** Create a vault with a default profile and the default privacy rules. Returns the key once. */
export async function createVault(): Promise<GhostVaultCreated> {
  const key = `${GHOST_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const last4 = key.slice(-4);

  const vaultId = await tx(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO ghost_vaults (key_hash, key_last4) VALUES ($1, $2) RETURNING id",
      [hashGhostKey(key), last4],
    );
    const id = rows[0]!.id;
    for (const [field, mode] of Object.entries(DEFAULT_RULES)) {
      await client.query("INSERT INTO ghost_rules (vault_id, field, mode) VALUES ($1, $2, $3)", [id, field, mode]);
    }
    const { email_alias, aliases } = generateAliases(randomBytes(3).toString("hex"));
    await client.query(
      "INSERT INTO ghost_profiles (vault_id, name, email_alias, aliases) VALUES ($1, $2, $3, $4)",
      [id, "Primary", email_alias, aliases],
    );
    return id;
  });

  return { vault_key: key, key_last4: last4, profiles: await listProfiles(vaultId), rules: await getRules(vaultId) };
}

export async function authenticateVault(key: string): Promise<GhostVault | null> {
  if (!validGhostKey(key)) return null;
  const { rows } = await db.query<GhostVault>(
    `SELECT id, key_last4 AS "keyLast4", budget_usd::float8 AS "budgetUsd", created_at AS "createdAt"
     FROM ghost_vaults WHERE key_hash = $1`,
    [hashGhostKey(key)],
  );
  return rows[0] ?? null;
}
