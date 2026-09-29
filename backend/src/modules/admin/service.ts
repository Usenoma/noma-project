import { db, setSetting, tx } from "../../db/pool.js";
import { badRequest, notFound } from "../../lib/errors.js";
import type { MarkupConfig } from "../catalog/pricing.js";
import { startRefund } from "../refunds/service.js";

export async function setMarkup(markup: MarkupConfig) {
  await setSetting("markup_pct", markup);
  // reprice immediately instead of waiting for the next catalog-sync
  await db.query(
    `UPDATE products SET price_usd = ceil(cost_usd * (1 + COALESCE(($1::jsonb ->> category)::numeric, ($1::jsonb ->> 'default')::numeric)) * 100) / 100`,
    [JSON.stringify(markup)],
  );
}

export async function setProductActive(id: string, active: boolean) {
  const { rowCount } = await db.query("UPDATE products SET active = $2 WHERE id = $1", [id, active]);
  if (!rowCount) throw notFound("product");
}

export async function suppliers() {
  const { rows } = await db.query(
    "SELECT id, name, category, status, balance_usd, balance_alert_usd, updated_at FROM suppliers ORDER BY id",
  );
  return rows;
}

export async function setSupplierBalanceAlert(id: string, alertUsd: number) {
  const { rowCount } = await db.query("UPDATE suppliers SET balance_alert_usd = $2 WHERE id = $1", [id, alertUsd]);
  if (!rowCount) throw notFound("supplier");
}

export async function manualRefund(orderId: string) {
  // a manual refund is allowed from any stuck paid/fulfilling state: force to failed first
  await db.query(
    `UPDATE orders SET status = 'failed', updated_at = now() WHERE id = $1 AND status IN ('paid', 'fulfilling')`,
    [orderId],
  );
  if (!(await startRefund(orderId))) throw badRequest("order is not in a refundable state");
}

export interface NewCycle {
  week_no: number;
  stock_symbol: string;
  stock_token_address?: string;
  starts_at: string;
  ends_at: string;
}

export async function scheduleCycle(c: NewCycle) {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO reward_cycles (week_no, stock_symbol, stock_token_address, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [c.week_no, c.stock_symbol, c.stock_token_address ?? null, c.starts_at, c.ends_at],
  );
  return rows[0]!;
}

/** Reveal: the lowest upcoming cycle becomes active. Only allowed when no cycle is active. */
export async function revealNextCycle() {
  return tx(async (client) => {
    const active = await client.query("SELECT 1 FROM reward_cycles WHERE status = 'active'");
    if (active.rowCount) throw badRequest("a cycle is already active");
    const { rows } = await client.query<{ id: number; week_no: number; stock_symbol: string }>(
      `UPDATE reward_cycles SET status = 'active', revealed_at = now()
       WHERE id = (SELECT id FROM reward_cycles WHERE status = 'upcoming' ORDER BY week_no LIMIT 1)
       RETURNING id, week_no, stock_symbol`,
    );
    if (!rows[0]) throw notFound("upcoming cycle");
    return rows[0];
  });
}
