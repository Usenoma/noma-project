import type { Address, Hex } from "viem";
import { config } from "../../config.js";
import { chain } from "../../chain/client.js";
import { db, tx } from "../../db/pool.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { QUEUE, queue } from "../../queues.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface ReportedPayment {
  tx_hash: string;
  asset: string;
  amount: string;
  payer_address: string;
  block: number;
}

export interface PaymentClaim {
  id: string;
  order_id: string;
  tx_hash: string;
  asset: string;
  amount: string;
  payer_address: string | null;
  status: "open" | "accepted" | "rejected";
  note: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

const paymentAddress = (): string => {
  if (!config.PAYMENT_ADDRESS) throw new Error("PAYMENT_ADDRESS not configured");
  return config.PAYMENT_ADDRESS.toLowerCase();
};

const topicAddress = (topic: Hex): string => `0x${topic.slice(26).toLowerCase()}`;

/**
 * Read a transfer out of a real transaction. The server decides what the transaction actually
 * contains; the buyer only supplies the hash. This detects native ETH, USDG, and other ERC-20
 * tokens sent to the fixed NOMA address (the last case is a wrong-asset payment).
 */
export async function readPaymentTx(txHash: string): Promise<ReportedPayment> {
  const hash = txHash as Hex;
  const receipt = await chain().getTransactionReceipt({ hash }).catch(() => null);
  if (!receipt || receipt.status !== "success") throw badRequest("transaction not found or reverted");
  const transaction = await chain().getTransaction({ hash }).catch(() => null);
  if (!transaction) throw badRequest("transaction not found");

  const to = paymentAddress();
  if (transaction.to?.toLowerCase() === to && transaction.value > 0n) {
    return {
      tx_hash: txHash,
      asset: "ETH",
      amount: transaction.value.toString(),
      payer_address: transaction.from.toLowerCase(),
      block: Number(receipt.blockNumber),
    };
  }

  for (const log of receipt.logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    if (topicAddress(log.topics[2]!) !== to) continue;
    const amount = BigInt(log.data);
    if (amount <= 0n) continue;
    const token = log.address.toLowerCase();
    return {
      tx_hash: txHash,
      asset: token === config.USDG_ADDRESS?.toLowerCase() ? "USDG" : `TOKEN:${token}`,
      amount: amount.toString(),
      payer_address: topicAddress(log.topics[1]!),
      block: Number(receipt.blockNumber),
    };
  }

  throw badRequest("no payment to the NOMA address in this transaction");
}

export async function createPaymentClaim(orderId: string, txHash: string): Promise<PaymentClaim> {
  const payment = await readPaymentTx(txHash);
  const { rows } = await db.query<PaymentClaim>(
    `INSERT INTO payment_claims (order_id, tx_hash, asset, amount, payer_address)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (order_id, tx_hash) DO UPDATE SET tx_hash = EXCLUDED.tx_hash
     RETURNING id, order_id, tx_hash, asset, amount, payer_address, status, note, created_at, resolved_at`,
    [orderId, payment.tx_hash, payment.asset, payment.amount, payment.payer_address],
  );
  return rows[0]!;
}

export async function listClaimsForOrder(orderId: string): Promise<PaymentClaim[]> {
  const { rows } = await db.query<PaymentClaim>(
    `SELECT id, order_id, tx_hash, asset, amount, payer_address, status, note, created_at, resolved_at
     FROM payment_claims WHERE order_id = $1 ORDER BY created_at DESC`,
    [orderId],
  );
  return rows;
}

export async function listPaymentClaims(status?: "open" | "accepted" | "rejected"): Promise<PaymentClaim[]> {
  const { rows } = await db.query<PaymentClaim>(
    `SELECT c.id, c.order_id, c.tx_hash, c.asset, c.amount, c.payer_address, c.status, c.note,
            c.created_at, c.resolved_at
     FROM payment_claims c
     WHERE ($1::text IS NULL OR c.status = $1)
     ORDER BY c.created_at DESC
     LIMIT 200`,
    [status ?? null],
  );
  return rows;
}

/**
 * Accepting a claim marks the invoice paid and lets fulfillment run, even when the watcher could
 * not attribute the transfer. Rejecting leaves the order untouched. This is deliberately admin-only.
 */
export async function resolvePaymentClaim(
  id: string,
  action: "accept" | "reject",
  note?: string,
): Promise<{ orderId: string; queued: boolean }> {
  const result = await tx(async (client) => {
    const { rows } = await client.query<PaymentClaim & { order_status: string }>(
      `SELECT c.*, o.status AS order_status
       FROM payment_claims c JOIN orders o ON o.id = c.order_id
       WHERE c.id = $1 FOR UPDATE`,
      [id],
    );
    const claim = rows[0];
    if (!claim) throw notFound("payment claim");
    if (claim.status !== "open") throw badRequest(`claim already ${claim.status}`);

    if (action === "reject") {
      await client.query(
        "UPDATE payment_claims SET status = 'rejected', note = $2, resolved_at = now() WHERE id = $1",
        [id, note ?? null],
      );
      return { orderId: claim.order_id, queued: false };
    }

    await client.query(
      "UPDATE payment_claims SET status = 'accepted', note = $2, resolved_at = now() WHERE id = $1",
      [id, note ?? null],
    );
    await client.query(
      `UPDATE invoices
       SET status = 'confirmed', received = $2, payer_address = $3, tx_hash = $4,
           confirmations = GREATEST(confirmations, 1)
       WHERE order_id = $1`,
      [claim.order_id, claim.amount, claim.payer_address, claim.tx_hash],
    );
    const { rowCount } = await client.query(
      `UPDATE orders SET status = 'paid', updated_at = now()
       WHERE id = $1 AND status IN ('created', 'awaiting_payment', 'expired', 'failed')`,
      [claim.order_id],
    );
    return { orderId: claim.order_id, queued: (rowCount ?? 0) > 0 };
  });

  if (result.queued) {
    await queue(QUEUE.fulfillment).add(
      "fulfill",
      { orderId: result.orderId },
      { jobId: `fulfill-${result.orderId}` },
    );
  }
  return result;
}

/** Used by the watcher: record an underpayment found from the attached buyer wallet. */
export async function markUnderpaid(input: {
  invoiceId: string;
  received: string;
  payer: string;
  txHash: string;
}): Promise<void> {
  await db.query(
    `UPDATE invoices
     SET status = 'underpaid', received = $2, payer_address = $3, tx_hash = $4
     WHERE id = $1 AND status IN ('pending', 'seen')`,
    [input.invoiceId, input.received, input.payer.toLowerCase(), input.txHash],
  );
}
