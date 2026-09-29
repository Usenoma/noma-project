import { db, tx } from "../../db/pool.js";
import { decryptJson, encryptJson } from "../../lib/crypto.js";
import { encryptionKey } from "../../lib/keys.js";
import { logger } from "../../lib/logger.js";
import { adapter } from "../../suppliers/registry.js";
import type { Deliverable } from "../../suppliers/types.js";
import { transition } from "../orders/service.js";

export class SupplierPendingError extends Error {}

interface FulfillmentContext {
  supplier_id: string;
  supplier_sku: string;
  customer_fields: string | null;
  status: string;
}

async function storeDeliverable(orderId: string, deliverable: Deliverable) {
  await tx(async (client) => {
    await client.query("INSERT INTO deliverables (order_id, type, payload_encrypted) VALUES ($1, $2, $3) ON CONFLICT (order_id) DO NOTHING", [
      orderId,
      deliverable.type,
      encryptJson(deliverable.payload, encryptionKey),
    ]);
    await client.query("UPDATE fulfillments SET status = 'done', updated_at = now() WHERE order_id = $1", [orderId]);
    await transition(client, orderId, "delivered");
  });
}

/**
 * Idempotent: safe to re-run for the same order. The supplier call uses idempotency_key = order id,
 * and once a supplier order id is recorded we only poll status instead of purchasing again.
 * Throws SupplierPendingError while the supplier is still working (the job retries with backoff).
 */
export async function fulfill(orderId: string): Promise<void> {
  // one run per order at a time: a concurrent duplicate job backs off and retries later
  const lock = await db.connect();
  try {
    const { rows } = await lock.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [orderId]);
    if (!rows[0]!.ok) throw new SupplierPendingError(`fulfillment for ${orderId} already running`);
    try {
      await fulfillLocked(orderId);
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [orderId]);
    }
  } finally {
    lock.release();
  }
}

async function fulfillLocked(orderId: string): Promise<void> {
  const { rows } = await db.query<FulfillmentContext>(
    `SELECT p.supplier_id, p.supplier_sku, o.customer_fields, o.status
     FROM orders o JOIN products p ON p.id = o.product_id WHERE o.id = $1`,
    [orderId],
  );
  const ctx = rows[0];
  if (!ctx) throw new Error(`order ${orderId} not found`);
  if (ctx.status === "paid") await transition(db, orderId, "fulfilling");
  else if (ctx.status !== "fulfilling") return; // delivered, failed, refunding, ... : nothing to do

  const supplier = adapter(ctx.supplier_id);
  const fields = ctx.customer_fields ? decryptJson<Record<string, string>>(ctx.customer_fields, encryptionKey) : {};

  await db.query(
    `INSERT INTO fulfillments (order_id, supplier_id, idempotency_key, request)
     VALUES ($1, $2, $3, $4) ON CONFLICT (idempotency_key) DO NOTHING`,
    [orderId, ctx.supplier_id, orderId, JSON.stringify({ sku: ctx.supplier_sku })],
  );
  const { rows: f } = await db.query<{ supplier_order_id: string | null }>(
    "UPDATE fulfillments SET attempt = attempt + 1, updated_at = now() WHERE idempotency_key = $1 RETURNING supplier_order_id",
    [orderId],
  );

  let supplierOrderId = f[0]!.supplier_order_id;
  if (!supplierOrderId) {
    const res = await supplier.purchase(ctx.supplier_sku, fields, orderId);
    supplierOrderId = res.supplierOrderId;
    await db.query("UPDATE fulfillments SET supplier_order_id = $2, updated_at = now() WHERE idempotency_key = $1", [
      orderId,
      supplierOrderId,
    ]);
    logger.info({ orderId, supplier: supplier.id, supplierOrderId }, "supplier purchase placed");
    if (res.deliverable) return storeDeliverable(orderId, res.deliverable);
  }

  const status = await supplier.status(supplierOrderId);
  if (status === "pending") throw new SupplierPendingError(`supplier order ${supplierOrderId} pending`);
  if (status === "failed") throw new Error(`supplier order ${supplierOrderId} failed`);
  await storeDeliverable(orderId, await supplier.deliverable(supplierOrderId));
}

/** Called when the fulfillment job has exhausted its retries. */
export async function markFulfillmentFailed(orderId: string, error: string): Promise<void> {
  await tx(async (client) => {
    await client.query("UPDATE fulfillments SET status = 'failed', error = $2, updated_at = now() WHERE idempotency_key = $1", [
      orderId,
      error,
    ]);
    await transition(client, orderId, "failed");
  });
}
