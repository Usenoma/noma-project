import { encodeFunctionData, type Address } from "viem";
import { refundWallet } from "../../chain/client.js";
import { sendOnce } from "../../chain/sendOnce.js";
import { erc20Abi } from "../../chain/abis/index.js";
import { db, tx } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { QUEUE, queue } from "../../queues.js";
import { assetInfo, type PayAsset } from "../payments/assets.js";
import { transition } from "../orders/service.js";

/** failed → refunding: record what we owe (everything received) and to whom (the payer), then enqueue. */
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
    await client.query(
      `INSERT INTO refunds (order_id, amount, asset, to_address) VALUES ($1, $2, $3, $4)
       ON CONFLICT (order_id) DO NOTHING`,
      [orderId, inv.received, inv.asset, inv.payer_address],
    );
    return true;
  });
  if (started) await queue(QUEUE.refund).add("refund", { orderId }, { jobId: `refund-${orderId}` });
  return started;
}

/** Sends the refund exactly once (see sendOnce) and marks the order refunded on confirmation. */
export async function processRefund(orderId: string): Promise<void> {
  const { rows } = await db.query<{ id: string; amount: string; asset: PayAsset; to_address: Address }>(
    "SELECT id, amount, asset, to_address FROM refunds WHERE order_id = $1",
    [orderId],
  );
  const refund = rows[0];
  if (!refund) throw new Error(`no refund row for order ${orderId}`);

  const info = assetInfo(refund.asset);
  const amount = BigInt(refund.amount);
  const req = info.token
    ? { to: info.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [refund.to_address, amount] }) }
    : { to: refund.to_address, value: amount };

  let receipt;
  try {
    receipt = await sendOnce(`refund:${orderId}`, refundWallet(), req);
  } catch (err) {
    await db.query("UPDATE refunds SET status = 'failed' WHERE id = $1", [refund.id]);
    throw err;
  }
  logger.info({ orderId, hash: receipt.transactionHash }, "refund confirmed");
  await tx(async (client) => {
    await client.query("UPDATE refunds SET status = 'confirmed', tx_hash = $2 WHERE id = $1", [refund.id, receipt.transactionHash]);
    await transition(client, orderId, "refunded");
  });
}
