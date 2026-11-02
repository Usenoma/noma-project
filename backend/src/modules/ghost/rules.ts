import { db } from "../../db/pool.js";

/** Privacy Router: the fields the agent may ever need to share, and the default stance. */
export const GHOST_FIELDS = ["email", "name", "phone", "address", "wallet"] as const;
export type GhostField = (typeof GHOST_FIELDS)[number];
export type GhostRuleMode = "alias" | "deny";
export type GhostRules = Record<GhostField, GhostRuleMode>;

export const DEFAULT_RULES: GhostRules = {
  email: "alias",
  name: "alias",
  phone: "deny",
  address: "deny",
  wallet: "deny",
};

/** Pure rule lookup: unknown fields fail closed (deny). */
export function evaluateRule(rules: Partial<Record<string, GhostRuleMode>>, field: string): GhostRuleMode {
  return rules[field] ?? "deny";
}

export async function getRules(vaultId: string): Promise<GhostRules> {
  const { rows } = await db.query<{ field: string; mode: GhostRuleMode }>(
    "SELECT field, mode FROM ghost_rules WHERE vault_id = $1",
    [vaultId],
  );
  return { ...DEFAULT_RULES, ...Object.fromEntries(rows.map((r) => [r.field, r.mode])) };
}

export async function setRules(vaultId: string, rules: Partial<GhostRules>): Promise<GhostRules> {
  for (const [field, mode] of Object.entries(rules)) {
    await db.query(
      `INSERT INTO ghost_rules (vault_id, field, mode) VALUES ($1, $2, $3)
       ON CONFLICT (vault_id, field) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`,
      [vaultId, field, mode],
    );
  }
  return getRules(vaultId);
}
