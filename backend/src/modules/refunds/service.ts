import { encodeFunctionData, type Address } from "viem";
import { refundWallet } from "../../chain/client.js";
import { sendOnce } from "../../chain/sendOnce.js";
import { erc20Abi } from "../../chain/abis/index.js";
import { db, tx } from "../../db/pool.js";
import { alert } from "../../lib/alerts.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { QUEUE, queue } from "../../queues.js";
import { assetInfo, type PayAsset } from "../payments/assets.js";
import { transition } from "../orders/service.js";

export type RefundKind = "full" | "overpayment";
export type RefundStatus = "pending" | "sent" | "confirmed" | "failed";

export interface RefundListRow {
  id: string;
  order_id: string;
  kind: RefundKind;
  amount: string;
  asset: string;
  to_address: string;
  tx_hash: string | null;
  status: RefundStatus;
  created_at: Date;
}

export async function listRefunds(status?: RefundStatus): Promise<RefundListRow[]> {
  const { rows } = await db.query<RefundListRow>(
    `SELECT id, order_id, kind, amount, asset, to_address, tx_hash, status, created_at
     FROM refunds WHERE ($1::text IS NULL OR status = $1)
     ORDER BY created_at DESC LIMIT 100`,
    [status ?? null],
  );
  return rows;
}

const enqueue = (orderId: string, kind: RefundKind) =>
  queue(QUEUE.refund).add("refund", { orderId, kind }, { jobId: `refund-${kind}-${orderId}` });

/**
 * failed | expired → refunding: refund everything received on the invoice to the payer.
 * Throws (for an admin alert) when the payer is unknown or nothing was received.
 */
export async function startRefund(orderId: string): Promise<boolean> {
  const started = await tx(async (client) => {
    if (!(await transition(client, orderId, "refunding"))) return false;
    const { rows } = await client.query<{ asset: string; received: string; payer_address: string | null }>(
      "SELECT asset, received, payer_address FROM invoices WHERE order_id = $1",
      [orderId],
    );
    const inv = rows[0];
    if (!inv?.payer_address || BigInt(inv.received) === 0n) {
      throw new Error(`order ${orderId}: no payer address / nothing received, refund needs manual handling`);
    }
    // an overpayment already refunded is not refunded twice
    const { rows: prior } = await client.query<{ amount: string }>(
      "SELECT amount FROM refunds WHERE order_id = $1 AND kind = 'overpayment'",
      [orderId],
    );
    const amount = BigInt(inv.received) - BigInt(prior[0]?.amount ?? 0);
    await client.query(
      `INSERT INTO refunds (order_id, kind, amount, asset, to_address) VALUES ($1, 'full', $2, $3, $4)
       ON CONFLICT (order_id, kind) DO NOTHING`,
      [orderId, amount.toString(), inv.asset, inv.payer_address],
    );
    return true;
  });
  if (started) await enqueue(orderId, "full");
  return started;
}

/** Refund the amount paid above the invoice. The order itself proceeds normally. */
export async function startOverpaymentRefund(orderId: string, amount: bigint, asset: string, payer: string): Promise<void> {
  const { rowCount } = await db.query(
    `INSERT INTO refunds (order_id, kind, amount, asset, to_address) VALUES ($1, 'overpayment', $2, $3, $4)
     ON CONFLICT (order_id, kind) DO NOTHING`,
    [orderId, amount.toString(), asset, payer],
  );
  if (rowCount) await enqueue(orderId, "overpayment");
}

/** Sends the refund exactly once (see sendOnce). A full refund also closes the order as refunded. */
export async function processRefund(orderId: string, kind: RefundKind = "full"): Promise<void> {
  const { rows } = await db.query<{ id: string; amount: string; asset: PayAsset; to_address: Address }>(
    "SELECT id, amount, asset, to_address FROM refunds WHERE order_id = $1 AND kind = $2",
    [orderId, kind],
  );
  const refund = rows[0];
  if (!refund) throw new Error(`no ${kind} refund row for order ${orderId}`);

  const info = assetInfo(refund.asset);
  const amount = BigInt(refund.amount);
  const req = info.token
    ? { to: info.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [refund.to_address, amount] }) }
    : { to: refund.to_address, value: amount };

  let receipt;
  try {
    // purpose for full refunds kept as 'refund:<order>' so earlier recorded txs still match
    receipt = await sendOnce(kind === "full" ? `refund:${orderId}` : `refund-${kind}:${orderId}`, refundWallet(), req);
  } catch (err) {
    await db.query("UPDATE refunds SET status = 'failed' WHERE id = $1", [refund.id]);
    await alert(
      "refund failed",
      { orderId, kind, err: String(err) },
      { kind: "action", key: `refund-failed:${orderId}:${kind}`, cooldownSeconds: 6 * 3600 },
    );
    throw err;
  }
  logger.info({ orderId, kind, hash: receipt.transactionHash }, "refund confirmed");
  await tx(async (client) => {
    await client.query("UPDATE refunds SET status = 'confirmed', tx_hash = $2 WHERE id = $1", [refund.id, receipt.transactionHash]);
    if (kind === "full") await transition(client, orderId, "refunded");
  });
}

/**
 * Re-enqueue a failed refund after an operator has fixed the cause (e.g. topped up gas/float).
 * The row is reset to pending and a new job id is used so a stale failed job cannot swallow it.
 */
export async function retryRefund(orderId: string, kind: RefundKind = "full"): Promise<void> {
  const { rows } = await db.query<{ id: string; status: string }>(
    "SELECT id, status FROM refunds WHERE order_id = $1 AND kind = $2",
    [orderId, kind],
  );
  const refund = rows[0];
  if (!refund) throw notFound("refund");
  if (refund.status === "confirmed") throw badRequest("refund already confirmed");

  await db.query("UPDATE refunds SET status = 'pending' WHERE id = $1", [refund.id]);
  await queue(QUEUE.refund).add(
    "refund",
    { orderId, kind },
    { jobId: `refund-${kind}-${orderId}-retry-${Date.now()}` },
  );
  logger.info({ orderId, kind, refundId: refund.id }, "refund retry queued");
}
