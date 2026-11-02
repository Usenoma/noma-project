import { db } from "../../db/pool.js";

/**
 * Ghost Payment v1: a per-vault spending budget authorizes agent-originated orders. The agent
 * never holds a key or signs: it creates an order (invoice) and the user pays from their wallet.
 * Budget consumption is derived from live orders, so expired/failed/refunded purchases free it up.
 */

const VOID_ORDER_STATUSES = "('expired','failed','refunded','cancelled')";

export async function remainingBudget(vaultId: string): Promise<number> {
  const { rows } = await db.query<{ remaining: string }>(
    `SELECT v.budget_usd - COALESCE((
       SELECT sum(gp.price_usd) FROM ghost_purchases gp
       JOIN orders o ON o.id = gp.order_id
       WHERE gp.vault_id = v.id AND o.status NOT IN ${VOID_ORDER_STATUSES}
     ), 0) AS remaining
     FROM ghost_vaults v WHERE v.id = $1`,
    [vaultId],
  );
  return Math.max(0, Number(rows[0]?.remaining ?? 0));
}

export async function setBudget(vaultId: string, maxUsd: number): Promise<number> {
  await db.query("UPDATE ghost_vaults SET budget_usd = $2 WHERE id = $1", [vaultId, maxUsd]);
  return maxUsd;
}

export interface PurchaseRecord {
  vault_id: string;
  mission_id: string;
  order_id: string;
  product_id: string;
  title: string;
  price_usd: number;
}

export async function recordPurchase(p: PurchaseRecord): Promise<void> {
  await db.query(
    `INSERT INTO ghost_purchases (vault_id, mission_id, order_id, product_id, title, price_usd)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [p.vault_id, p.mission_id, p.order_id, p.product_id, p.title, p.price_usd],
  );
}

/** Purchases made by a mission, newest last (the chat reply and the receipt use this). */
export async function missionPurchases(missionId: string) {
  const { rows } = await db.query<{
    order_id: string;
    product_id: string;
    title: string;
    price_usd: string;
  }>(
    "SELECT order_id, product_id, title, price_usd FROM ghost_purchases WHERE mission_id = $1 ORDER BY created_at",
    [missionId],
  );
  return rows;
}
