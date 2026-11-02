import { db } from "../../db/pool.js";
import { notFound } from "../../lib/errors.js";

export type SubscriptionStatus = "active" | "cancelled" | "expired";

interface SubscriptionRow {
  id: string;
  owner: string;
  service: string;
  supplier_id: string | null;
  order_id: string | null;
  renewal_at: string | null;
  price_usd: string | null;
  status: SubscriptionStatus;
  last_seen_at: string | null;
}

export interface SubscriptionView extends SubscriptionRow {
  recommendation: string | null;
}

const DAY = 86_400_000;

/**
 * Rule-based recommendation (no LLM). Returns a short reason and nothing else, so a recommendation
 * without evidence is never rendered. Null when there is nothing to flag.
 */
export function recommend(s: SubscriptionRow, now = Date.now()): string | null {
  if (s.status !== "active") return null;
  if (s.last_seen_at) {
    const idleDays = Math.floor((now - new Date(s.last_seen_at).getTime()) / DAY);
    if (idleDays >= 45) return `unused? no login in ${idleDays} days`;
  }
  if (s.renewal_at) {
    const daysLeft = Math.ceil((new Date(s.renewal_at).getTime() - now) / DAY);
    if (daysLeft >= 0 && daysLeft <= 3) return `renews in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
  }
  return null;
}

export async function listSubscriptions(owner: string): Promise<SubscriptionView[]> {
  const { rows } = await db.query<SubscriptionRow>(
    `SELECT id, owner, service, supplier_id, order_id, renewal_at, price_usd, status, last_seen_at
     FROM subscriptions WHERE owner = $1 ORDER BY renewal_at NULLS LAST, service`,
    [owner.toLowerCase()],
  );
  return rows.map((r) => ({ ...r, recommendation: recommend(r) }));
}

/** The agent never cancels or renews itself; the buyer records the decision. Owner is verified. */
export async function recordDecision(id: string, decision: "keep" | "cancel", owner: string): Promise<void> {
  const { rows } = await db.query<{ owner: string }>("SELECT owner FROM subscriptions WHERE id = $1", [id]);
  if (!rows[0] || rows[0].owner.toLowerCase() !== owner.toLowerCase()) throw notFound("subscription");
  const status: SubscriptionStatus = decision === "cancel" ? "cancelled" : "active";
  await db.query("UPDATE subscriptions SET status = $2 WHERE id = $1", [id, status]);
  await db.query("INSERT INTO subscription_events (subscription_id, kind, data) VALUES ($1, 'decision', $2)", [
    id,
    JSON.stringify({ decision }),
  ]);
}

/** Upsert the subscription record after a purchase (called by fulfillment once enabled). */
export async function recordSubscription(input: {
  owner: string;
  service: string;
  supplierId?: string | null;
  orderId?: string | null;
  renewalAt?: Date | null;
  priceUsd?: string | null;
}): Promise<void> {
  await db.query(
    `INSERT INTO subscriptions (owner, service, supplier_id, order_id, renewal_at, price_usd)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (order_id) WHERE order_id IS NOT NULL
     DO UPDATE SET service = EXCLUDED.service, supplier_id = EXCLUDED.supplier_id,
                   renewal_at = EXCLUDED.renewal_at, price_usd = EXCLUDED.price_usd`,
    [
      input.owner.toLowerCase(),
      input.service,
      input.supplierId ?? null,
      input.orderId ?? null,
      input.renewalAt ?? null,
      input.priceUsd ?? null,
    ],
  );
}
