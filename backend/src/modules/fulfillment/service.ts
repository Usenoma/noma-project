import { DelayedError, type Job } from "bullmq";
import { config } from "../../config.js";
import { db, tx } from "../../db/pool.js";
import { alert } from "../../lib/alerts.js";
import { decryptJson, encryptJson } from "../../lib/crypto.js";
import { encryptionKey } from "../../lib/keys.js";
import { logger } from "../../lib/logger.js";
import { QUEUE, queue } from "../../queues.js";
import { adapter } from "../../suppliers/registry.js";
import type { Deliverable } from "../../suppliers/types.js";
import { transition } from "../orders/service.js";
import { startRefund } from "../refunds/service.js";

export class SupplierPendingError extends Error {}

interface FulfillmentContext {
  supplier_id: string;
  supplier_sku: string;
  customer_fields: string | null;
  status: string;
  duration_days: string | null;
}

/** Time-limited resource (e.g. VPS rental) to be released by the expiry job. */
interface Lifetime {
  supplierId: string;
  supplierOrderId: string;
  days: number;
}

async function storeDeliverable(orderId: string, deliverable: Deliverable, lifetime?: Lifetime) {
  await tx(async (client) => {
    await client.query("INSERT INTO deliverables (order_id, type, payload_encrypted) VALUES ($1, $2, $3) ON CONFLICT (order_id) DO NOTHING", [
      orderId,
      deliverable.type,
      encryptJson(deliverable.payload, encryptionKey),
    ]);
    if (lifetime) {
      await client.query(
        `INSERT INTO supplier_resources (order_id, supplier_id, supplier_order_id, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(days => $4)) ON CONFLICT (order_id) DO NOTHING`,
        [orderId, lifetime.supplierId, lifetime.supplierOrderId, lifetime.days],
      );
    }
    await client.query("UPDATE fulfillments SET status = 'done', updated_at = now() WHERE order_id = $1", [orderId]);
    await transition(client, orderId, "delivered");
  });
}

/**
 * Idempotent: safe to re-run for the same order. The supplier call uses idempotency_key = order id,
 * and once a supplier order id is recorded we only poll status instead of purchasing again.
 * Throws SupplierPendingError while the supplier is still working (the job waits and re-checks).
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
    `SELECT p.supplier_id, p.supplier_sku, o.customer_fields, o.status, p.specs ->> 'duration_days' AS duration_days
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

  const lifetimeFor = (supplierOrderId: string): Lifetime | undefined =>
    ctx.duration_days && supplier.release
      ? { supplierId: supplier.id, supplierOrderId, days: Number(ctx.duration_days) }
      : undefined;

  let supplierOrderId = f[0]!.supplier_order_id;
  if (!supplierOrderId) {
    const res = await supplier.purchase(ctx.supplier_sku, fields, orderId);
    supplierOrderId = res.supplierOrderId;
    await db.query("UPDATE fulfillments SET supplier_order_id = $2, updated_at = now() WHERE idempotency_key = $1", [
      orderId,
      supplierOrderId,
    ]);
    logger.info({ orderId, supplier: supplier.id, supplierOrderId }, "supplier purchase placed");
    if (res.deliverable) return storeDeliverable(orderId, res.deliverable, lifetimeFor(supplierOrderId));
  }

  const status = await supplier.status(supplierOrderId);
  if (status === "pending") throw new SupplierPendingError(`supplier order ${supplierOrderId} pending`);
  if (status === "failed") throw new Error(`supplier order ${supplierOrderId} failed`);
  await storeDeliverable(orderId, await supplier.deliverable(supplierOrderId), lifetimeFor(supplierOrderId));
}

/** While the supplier is still working the order is re-checked at this pace (a webhook nudge may come sooner). */
const PENDING_RECHECK_MS = 30_000;
/** Past the wait limit the order is a human's to resolve; slower re-checks so a late delivery still lands. */
const OVERDUE_RECHECK_MS = 10 * 60_000;
const OVERDUE_REMIND_SECONDS = 6 * 3600;

/** Time until the next re-check of a pending order. Alerts once the supplier has been pending too long. */
async function pendingRecheckDelay(orderId: string): Promise<number> {
  const { rows } = await db.query<{ supplier_id: string; supplier_order_id: string | null; minutes: string }>(
    "SELECT supplier_id, supplier_order_id, extract(epoch FROM now() - created_at) / 60 AS minutes FROM fulfillments WHERE order_id = $1",
    [orderId],
  );
  const f = rows[0];
  if (!f || Number(f.minutes) < config.FULFILLMENT_PENDING_ALERT_MINUTES) return PENDING_RECHECK_MS;
  await alert(
    "supplier order still pending: resolve with the supplier, or refund via POST /admin/orders/:id/refund",
    { orderId, supplier: f.supplier_id, supplierOrderId: f.supplier_order_id, pending_minutes: Math.round(Number(f.minutes)) },
    { kind: "action", key: `fulfillment-pending:${orderId}`, cooldownSeconds: OVERDUE_REMIND_SECONDS },
  );
  return OVERDUE_RECHECK_MS;
}

/**
 * Processor of the fulfillment queue. A supplier that is still working never uses up the order's
 * attempts and is never refunded automatically (it may still deliver): the job goes back to wait
 * and is re-checked, and after FULFILLMENT_PENDING_ALERT_MINUTES a human is alerted. Only real
 * errors count towards failure and refund.
 */
export async function processFulfillmentJob(job: Job<{ orderId: string }>, token?: string): Promise<void> {
  try {
    await fulfill(job.data.orderId);
  } catch (err) {
    if (!(err instanceof SupplierPendingError) || job.name === NUDGE_JOB) throw err;
    await job.moveToDelayed(Date.now() + (await pendingRecheckDelay(job.data.orderId)), token);
    throw new DelayedError();
  }
}

/** Extra fulfillment pass triggered by a supplier webhook; never counts against the order's retries. */
export const NUDGE_JOB = "fulfill-nudge";

/**
 * A supplier says an order changed: run fulfill() now instead of waiting for the next backoff retry.
 * Only orders still being fulfilled at that supplier match. The pass is a separate one-shot job, so
 * the order's own job keeps its attempts and stays the only one that can fail the order.
 */
export async function nudgeFulfillment(supplierId: string, ref: { orderId: string } | { supplierOrderId: string }): Promise<boolean> {
  const byOrder = "orderId" in ref;
  const { rows } = await db.query<{ order_id: string }>(
    `SELECT f.order_id FROM fulfillments f JOIN orders o ON o.id = f.order_id
     WHERE f.supplier_id = $1 AND o.status = 'fulfilling' AND ${byOrder ? "f.order_id = $2" : "f.supplier_order_id = $2"}`,
    [supplierId, byOrder ? ref.orderId : ref.supplierOrderId],
  );
  const orderId = rows[0]?.order_id;
  if (!orderId) return false;
  await queue(QUEUE.fulfillment).add(
    NUDGE_JOB,
    { orderId },
    // one queued nudge per order; removed when it ends so a later notification can queue again
    { jobId: `nudge-${orderId}`, attempts: 1, removeOnComplete: true, removeOnFail: true },
  );
  return true;
}

/**
 * Failed-job handler of the fulfillment queue: once the order's own job has used its last attempt
 * the order fails and is refunded. Earlier attempts and webhook nudges change nothing.
 */
export async function onFulfillmentJobFailed(job: Job<{ orderId: string }> | undefined, err: Error): Promise<void> {
  if (!job || job.name === NUDGE_JOB || job.attemptsMade < (job.opts.attempts ?? 1)) return;
  const { orderId } = job.data;
  await markFulfillmentFailed(orderId, err.message);
  await startRefund(orderId).catch((e) => alert("refund could not start", { orderId, err: e.message }, { key: `refund-start:${orderId}` }));
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
