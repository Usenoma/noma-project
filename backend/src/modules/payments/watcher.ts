import { getAddress, type Address } from "viem";
import { config } from "../../config.js";
import { chain } from "../../chain/client.js";
import { erc20Abi } from "../../chain/abis/index.js";
import { db, tx } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { QUEUE, queue } from "../../queues.js";
import { transition } from "../orders/service.js";
import { startOverpaymentRefund, startRefund } from "../refunds/service.js";
import { assetInfo, usdPrice, type PayAsset } from "./assets.js";

interface WatchedInvoice {
  id: string;
  order_id: string;
  asset: PayAsset;
  amount: string;
  pay_to: Address;
  status: "pending" | "seen" | "underpaid" | "expired";
  expired: boolean;
  past_grace: boolean;
  start_block: string | null;
}

/** How far back to look for the ERC-20 Transfer that identifies the payer (for refunds). */
const PAYER_LOOKBACK_BLOCKS = 200_000n;
/** A payment broadcast right at the deadline is still accepted if it lands within this window. */
const EXPIRY_GRACE = "2 minutes";
/** An incomplete (underpaid) invoice is held this long past expiry for a top-up, then refunded. */
const UNDERPAID_GRACE = "24 hours";
/** Expired invoices keep being watched this long so late payments get refunded. */
const LATE_PAYMENT_WINDOW = "7 days";

async function balanceAt(asset: PayAsset, holder: Address, blockNumber: bigint): Promise<bigint> {
  const info = assetInfo(asset);
  return info.token
    ? chain().readContract({ address: info.token, abi: erc20Abi, functionName: "balanceOf", args: [holder], blockNumber })
    : chain().getBalance({ address: holder, blockNumber });
}

/**
 * Native ETH has no Transfer log. Binary-search the first block where the deposit address held
 * ETH (O(log n) historical balance reads), then take the sender of the direct transfer in that block.
 * A deposit made by a contract (internal transfer) has no direct tx: returns null → manual refund.
 */
async function findEthPayer(payTo: Address, fromBlock: bigint, head: bigint): Promise<{ payer: Address; txHash: string } | null> {
  let lo = fromBlock;
  let hi = head;
  if ((await chain().getBalance({ address: payTo, blockNumber: hi })) === 0n) return null;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if ((await chain().getBalance({ address: payTo, blockNumber: mid })) > 0n) hi = mid;
    else lo = mid + 1n;
  }
  const block = await chain().getBlock({ blockNumber: lo, includeTransactions: true });
  const deposit = block.transactions.find((t) => t.to?.toLowerCase() === payTo.toLowerCase() && t.value > 0n);
  return deposit ? { payer: getAddress(deposit.from), txHash: deposit.hash } : null;
}

/** Payer = sender of the payment into the deposit address; refunds go back there. */
async function findPayer(
  asset: PayAsset,
  payTo: Address,
  startBlock: bigint | null,
  head: bigint,
): Promise<{ payer: Address; txHash: string } | null> {
  const info = assetInfo(asset);
  const fromBlock = startBlock ?? (head > PAYER_LOOKBACK_BLOCKS ? head - PAYER_LOOKBACK_BLOCKS : 0n);
  if (!info.token) return findEthPayer(payTo, fromBlock, head);
  const logs = await chain().getContractEvents({
    address: info.token,
    abi: erc20Abi,
    eventName: "Transfer",
    args: { to: payTo },
    fromBlock,
    toBlock: head,
  });
  const last = logs.at(-1);
  return last?.args.from ? { payer: last.args.from, txHash: last.transactionHash } : null;
}

/** Overpayments worth less than this are kept (the refund gas would exceed them). */
async function refundableOverpayment(asset: PayAsset, excess: bigint): Promise<boolean> {
  if (excess <= 0n) return false;
  const info = assetInfo(asset);
  const usd = (Number(excess) / 10 ** info.decimals) * (await usdPrice(asset).catch(() => 0));
  return usd >= config.OVERPAY_REFUND_MIN_USD;
}

async function recordPayer(inv: WatchedInvoice, head: bigint) {
  const invoiceId = inv.id;
  const startBlock = inv.start_block === null ? null : BigInt(inv.start_block);
  const payer = await findPayer(inv.asset, inv.pay_to, startBlock, head).catch((err) => {
    logger.warn({ err: String(err), invoiceId }, "payer lookup failed");
    return null;
  });
  await db.query("UPDATE invoices SET payer_address = COALESCE($2, payer_address), tx_hash = COALESCE($3, tx_hash) WHERE id = $1", [
    invoiceId,
    payer?.payer.toLowerCase() ?? null,
    payer?.txHash ?? null,
  ]);
  return payer?.payer.toLowerCase() ?? null;
}

async function onConfirmed(inv: WatchedInvoice, received: bigint, head: bigint) {
  const amount = BigInt(inv.amount);
  const paid = await tx(async (client) => {
    await client.query("UPDATE invoices SET status = 'confirmed', received = $2, confirmations = $3 WHERE id = $1", [
      inv.id,
      received.toString(),
      config.PAYMENT_CONFIRMATIONS,
    ]);
    return transition(client, inv.order_id, "paid");
  });
  if (!paid) return;
  const payer = await recordPayer(inv, head);
  await queue(QUEUE.fulfillment).add("fulfill", { orderId: inv.order_id }, { jobId: `fulfill-${inv.order_id}` });
  logger.info({ orderId: inv.order_id, excess: (received - amount).toString() }, "invoice paid");

  if (await refundableOverpayment(inv.asset, received - amount)) {
    if (payer) await startOverpaymentRefund(inv.order_id, received - amount, inv.asset, payer);
    else logger.error({ orderId: inv.order_id }, "ALERT overpayment with unknown payer, refund manually");
  }
}

/** Funds that arrived after expiry (or an underpayment never completed) are refunded in full. */
async function onLatePayment(inv: WatchedInvoice, received: bigint, head: bigint) {
  await db.query("UPDATE invoices SET status = 'late_paid', received = $2 WHERE id = $1", [inv.id, received.toString()]);
  await transition(db, inv.order_id, "expired");
  await recordPayer(inv, head);
  await startRefund(inv.order_id).catch((err) =>
    logger.error({ orderId: inv.order_id, err: String(err) }, "ALERT late payment refund could not start"),
  );
}

/**
 * One pass over watched invoices. Deposit addresses are unique per invoice, so the balance of the
 * address is the amount paid. "Confirmed" = balance at (head - confirmations + 1) covers the amount.
 */
export async function watchPayments(): Promise<void> {
  const head = await chain().getBlockNumber();
  const confirmedBlock = head - BigInt(config.PAYMENT_CONFIRMATIONS) + 1n;

  const { rows } = await db.query<WatchedInvoice>(
    `SELECT id, order_id, asset, amount, pay_to, status, start_block,
       expires_at < now() - interval '${EXPIRY_GRACE}' AS expired,
       expires_at < now() - interval '${UNDERPAID_GRACE}' AS past_grace
     FROM invoices
     WHERE status IN ('pending', 'seen', 'underpaid')
        OR (status = 'expired' AND expires_at > now() - interval '${LATE_PAYMENT_WINDOW}')`,
  );

  for (const inv of rows) {
    try {
      const amount = BigInt(inv.amount);
      const [atHead, atConfirmed] = await Promise.all([
        balanceAt(inv.asset, inv.pay_to, head),
        balanceAt(inv.asset, inv.pay_to, confirmedBlock),
      ]);

      if (inv.status === "expired") {
        if (atConfirmed > 0n) await onLatePayment(inv, atConfirmed, head);
        continue;
      }

      // Nothing was seen before the deadline: anything arriving now is a late payment.
      if (inv.expired && inv.status === "pending") {
        if (atConfirmed > 0n) await onLatePayment(inv, atConfirmed, head);
        else if (atHead === 0n) {
          await tx(async (client) => {
            await client.query("UPDATE invoices SET status = 'expired' WHERE id = $1", [inv.id]);
            await transition(client, inv.order_id, "expired");
          });
        } // else: unconfirmed late deposit, wait for confirmations
        continue;
      }

      // Seen before the deadline: confirming afterwards still counts as paid.
      if (atConfirmed >= amount) {
        await onConfirmed(inv, atConfirmed, head);
        continue;
      }

      if (inv.status === "underpaid" && inv.past_grace) {
        await onLatePayment(inv, atConfirmed, head);
        continue;
      }

      if (atHead > 0n) {
        const status = atHead >= amount ? "seen" : "underpaid";
        await db.query("UPDATE invoices SET status = $2, received = $3 WHERE id = $1", [inv.id, status, atHead.toString()]);
      }
    } catch (err) {
      logger.error({ err, invoiceId: inv.id }, "payment check failed");
    }
  }
}
