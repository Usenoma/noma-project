import { type Address } from "viem";
import { config } from "../../config.js";
import { chain } from "../../chain/client.js";
import { erc20Abi } from "../../chain/abis/index.js";
import { db, tx } from "../../db/pool.js";
import { alert } from "../../lib/alerts.js";
import { logger } from "../../lib/logger.js";
import { redis } from "../../redis.js";
import { QUEUE, queue } from "../../queues.js";
import { transition } from "../orders/service.js";
import { startOverpaymentRefund, startRefund } from "../refunds/service.js";
import { markUnderpaid } from "./claims.js";
import { assetInfo, usdPrice, type PayAsset } from "./assets.js";

interface WatchedInvoice {
  id: string;
  order_id: string;
  asset: PayAsset;
  amount: string;
  status: "pending" | "seen" | "underpaid" | "expired";
  expired: boolean;
  past_grace: boolean;
  start_block: string | null;
  wallet_address: string | null;
}

/** A payment broadcast right at the deadline is still accepted if it lands within this window. */
const EXPIRY_GRACE = "2 minutes";
/** An incomplete (underpaid) invoice is held this long past expiry for a top-up, then refunded. */
const UNDERPAID_GRACE = "24 hours";
/** Expired invoices keep being watched this long so late payments get refunded. */
const LATE_PAYMENT_WINDOW = "7 days";

const paymentAddress = (): Address => {
  if (!config.PAYMENT_ADDRESS) throw new Error("PAYMENT_ADDRESS not configured");
  return config.PAYMENT_ADDRESS as Address;
};

interface Payment {
  received: bigint;
  payer: Address;
  txHash: string;
  /** Block the payment landed in — drives the confirmation count. */
  block: bigint;
}

/**
 * ERC-20: a single `eth_getLogs` filtered to transfers into the fixed address. Amounts are unique
 * per invoice, so an exact-amount match attributes the payment to exactly one invoice.
 */
async function erc20Payment(token: Address, amount: bigint, fromBlock: bigint, head: bigint): Promise<Payment | null> {
  const logs = await chain().getContractEvents({
    address: token,
    abi: erc20Abi,
    eventName: "Transfer",
    args: { to: paymentAddress() },
    fromBlock,
    toBlock: head,
  });
  for (const log of logs) {
    const value = log.args.value;
    const from = log.args.from;
    if (value != null && from != null && value === amount) {
      return { received: value, payer: from, txHash: log.transactionHash, block: log.blockNumber };
    }
  }
  return null;
}

/** How long the ETH scan cursor and a found payment are kept (comfortably past the 7-day late window). */
const ETH_SCAN_TTL_SECONDS = 8 * 24 * 3600;
const ethScanKey = (id: string) => `payment:eth:scan:${id}`;
const ethPayKey = (id: string) => `payment:eth:found:${id}`;

/**
 * Native ETH has no Transfer log, so it needs a block scan. The scan is incremental: a Redis cursor
 * records the last block checked, so each pass reads only new blocks instead of re-reading the whole
 * window from the invoice's creation block. The first matching payment is cached with its block so
 * confirmations keep counting up after the payment block has scrolled past the scan window.
 */
async function ethPayment(inv: WatchedInvoice, amount: bigint, head: bigint): Promise<Payment | null> {
  const cached = await redis.get(ethPayKey(inv.id));
  if (cached) {
    const p = JSON.parse(cached) as { received: string; payer: string; txHash: string; block: string };
    return { received: BigInt(p.received), payer: p.payer as Address, txHash: p.txHash, block: BigInt(p.block) };
  }

  const cursor = await redis.get(ethScanKey(inv.id));
  const from = cursor !== null ? BigInt(cursor) + 1n : inv.start_block !== null ? BigInt(inv.start_block) : head;
  if (from > head) return null;

  const to = paymentAddress().toLowerCase();
  let found: Payment | null = null;
  for (let b = from; b <= head; b++) {
    const block = await chain().getBlock({ blockNumber: b, includeTransactions: true });
    for (const t of block.transactions) {
      if (t.to?.toLowerCase() === to && t.value === amount) {
        found = { received: t.value, payer: t.from, txHash: t.hash, block: b };
        break;
      }
    }
    if (found) break;
  }

  await redis.set(ethScanKey(inv.id), head.toString(), "EX", ETH_SCAN_TTL_SECONDS);
  if (found) {
    await redis.set(
      ethPayKey(inv.id),
      JSON.stringify({ received: found.received.toString(), payer: found.payer, txHash: found.txHash, block: found.block.toString() }),
      "EX",
      ETH_SCAN_TTL_SECONDS,
    );
  }
  return found;
}

async function paymentFor(inv: WatchedInvoice, amount: bigint, head: bigint): Promise<Payment | null> {
  const info = assetInfo(inv.asset);
  const fromBlock = inv.start_block !== null ? BigInt(inv.start_block) : 0n;
  return info.token ? erc20Payment(info.token, amount, fromBlock, head) : ethPayment(inv, amount, head);
}

const ethUnderKey = (id: string) => `payment:eth:under:${id}`;

/**
 * A buyer who attached a wallet and sent less than the invoice amount. This is only attributed when
 * the sender is the attached wallet; anything else is handled by the buyer-reported claim flow.
 */
async function erc20Underpayment(
  token: Address,
  amount: bigint,
  wallet: Address,
  fromBlock: bigint,
  head: bigint,
): Promise<Payment | null> {
  const logs = await chain().getContractEvents({
    address: token,
    abi: erc20Abi,
    eventName: "Transfer",
    args: { to: paymentAddress(), from: wallet },
    fromBlock,
    toBlock: head,
  });
  for (const log of logs) {
    const value = log.args.value;
    const from = log.args.from;
    if (value != null && from != null && value > 0n && value < amount) {
      return { received: value, payer: from, txHash: log.transactionHash, block: log.blockNumber };
    }
  }
  return null;
}

/** Native ETH underpayment from the attached wallet, using its own incremental scan cursor. */
async function ethUnderpayment(inv: WatchedInvoice, amount: bigint, head: bigint): Promise<Payment | null> {
  if (!inv.wallet_address) return null;
  const wallet = inv.wallet_address.toLowerCase();
  const cursor = await redis.get(ethUnderKey(inv.id));
  const from = cursor !== null ? BigInt(cursor) + 1n : inv.start_block !== null ? BigInt(inv.start_block) : head;
  if (from > head) return null;

  const to = paymentAddress().toLowerCase();
  let found: Payment | null = null;
  for (let b = from; b <= head; b++) {
    const block = await chain().getBlock({ blockNumber: b, includeTransactions: true });
    for (const t of block.transactions) {
      if (
        t.to?.toLowerCase() === to &&
        t.from.toLowerCase() === wallet &&
        t.value > 0n &&
        t.value < amount
      ) {
        found = { received: t.value, payer: t.from, txHash: t.hash, block: b };
        break;
      }
    }
    if (found) break;
  }
  await redis.set(ethUnderKey(inv.id), head.toString(), "EX", ETH_SCAN_TTL_SECONDS);
  return found;
}

async function underpaymentFor(inv: WatchedInvoice, amount: bigint, head: bigint): Promise<Payment | null> {
  if (!inv.wallet_address) return null;
  const info = assetInfo(inv.asset);
  const fromBlock = inv.start_block !== null ? BigInt(inv.start_block) : 0n;
  return info.token
    ? erc20Underpayment(info.token, amount, inv.wallet_address as Address, fromBlock, head)
    : ethUnderpayment(inv, amount, head);
}

async function onUnderpaidExpired(inv: WatchedInvoice) {
  await db.query("UPDATE invoices SET status = 'late_paid' WHERE id = $1", [inv.id]);
  await transition(db, inv.order_id, "expired");
  if (!config.REFUNDS_AUTO_ENABLED) {
    await alert(
      "underpayment expired; automatic refunds are disabled",
      { orderId: inv.order_id, invoiceId: inv.id, amount: inv.amount },
      { kind: "action", key: `refund-disabled:${inv.order_id}`, cooldownSeconds: 6 * 3600 },
    );
    return;
  }
  await startRefund(inv.order_id).catch((err) =>
    alert(
      "underpayment refund could not start",
      { orderId: inv.order_id, err: String(err) },
      { key: `underpaid-refund:${inv.order_id}` },
    ),
  );
}

/** Overpayments worth less than this are kept (the refund gas would exceed them). */
async function refundableOverpayment(asset: PayAsset, excess: bigint): Promise<boolean> {
  if (excess <= 0n) return false;
  const info = assetInfo(asset);
  const usd = (Number(excess) / 10 ** info.decimals) * (await usdPrice(asset).catch(() => 0));
  return usd >= config.OVERPAY_REFUND_MIN_USD;
}

async function onConfirmed(inv: WatchedInvoice, payment: Payment) {
  const amount = BigInt(inv.amount);
  const paid = await tx(async (client) => {
    await client.query(
      "UPDATE invoices SET status = 'confirmed', received = $2, confirmations = $3, payer_address = $4, tx_hash = $5 WHERE id = $1",
      [inv.id, payment.received.toString(), config.PAYMENT_CONFIRMATIONS, payment.payer.toLowerCase(), payment.txHash],
    );
    return transition(client, inv.order_id, "paid");
  });
  if (!paid) return;
  await queue(QUEUE.fulfillment).add("fulfill", { orderId: inv.order_id }, { jobId: `fulfill-${inv.order_id}` });
  logger.info({ orderId: inv.order_id, excess: (payment.received - amount).toString() }, "invoice paid");

  if (await refundableOverpayment(inv.asset, payment.received - amount)) {
    if (!config.REFUNDS_AUTO_ENABLED) {
      await alert(
        "overpayment received; automatic refunds are disabled",
        { orderId: inv.order_id, asset: inv.asset, excess: (payment.received - amount).toString() },
        { kind: "action", key: `refund-disabled:${inv.order_id}`, cooldownSeconds: 6 * 3600 },
      );
      return;
    }
    await startOverpaymentRefund(inv.order_id, payment.received - amount, inv.asset, payment.payer);
  }
}

/** Funds that arrived after expiry are held when automatic refunds are off. */
async function onLatePayment(inv: WatchedInvoice, payment: Payment) {
  await db.query(
    "UPDATE invoices SET status = 'late_paid', received = $2, payer_address = $3, tx_hash = $4 WHERE id = $1",
    [inv.id, payment.received.toString(), payment.payer.toLowerCase(), payment.txHash],
  );
  await transition(db, inv.order_id, "expired");
  if (!config.REFUNDS_AUTO_ENABLED) {
    await alert(
      "late payment received; automatic refunds are disabled",
      { orderId: inv.order_id, invoiceId: inv.id, asset: inv.asset, received: payment.received.toString() },
      { kind: "action", key: `refund-disabled:${inv.order_id}`, cooldownSeconds: 6 * 3600 },
    );
    return;
  }
  await startRefund(inv.order_id).catch((err) =>
    alert("late payment refund could not start", { orderId: inv.order_id, err: String(err) }, { key: `late-refund:${inv.order_id}` }),
  );
}

function isSupportedAsset(asset: string): asset is PayAsset {
  return asset === "USDG" || asset === "ETH";
}

/**
 * Expire an invoice and its order even when its asset can no longer be scanned.
 * Legacy rows (e.g. USDC from before the USDG rename) must not stall the watcher forever.
 */
async function expireInvoice(inv: WatchedInvoice): Promise<void> {
  await tx(async (client) => {
    await client.query("UPDATE invoices SET status = 'expired' WHERE id = $1", [inv.id]);
    await transition(client, inv.order_id, "expired");
  });
}

/**
 * One pass over watched invoices. All buyers pay into the same fixed address; each invoice is
 * identified by its unique amount, so a transfer of exactly that amount settles it. A payment is
 * confirmed once its block is `PAYMENT_CONFIRMATIONS` behind the head.
 */
export async function watchPayments(): Promise<void> {
  const head = await chain().getBlockNumber();
  const confirmations = BigInt(config.PAYMENT_CONFIRMATIONS);

  const { rows } = await db.query<WatchedInvoice>(
    `SELECT i.id, i.order_id, i.asset, i.amount, i.status, i.start_block, o.wallet_address,
       i.expires_at < now() - interval '${EXPIRY_GRACE}' AS expired,
       i.expires_at < now() - interval '${UNDERPAID_GRACE}' AS past_grace
     FROM invoices i JOIN orders o ON o.id = i.order_id
     WHERE i.status IN ('pending', 'seen', 'underpaid')
        OR (i.status = 'expired' AND i.expires_at > now() - interval '${LATE_PAYMENT_WINDOW}')`,
  );

  for (const inv of rows) {
    try {
      // A legacy invoice can carry an asset the current chain config no longer knows (USDC before
      // the USDG rename). It can never be scanned, so expire it instead of failing every pass.
      if (!isSupportedAsset(inv.asset)) {
        if (inv.status !== "expired" && inv.expired) await expireInvoice(inv);
        else if (inv.status !== "expired") {
          logger.error({ invoiceId: inv.id, asset: inv.asset }, "unsupported invoice asset");
        }
        continue;
      }

      const amount = BigInt(inv.amount);
      const payment = await paymentFor(inv, amount, head);
      const confirmed = payment !== null && head - payment.block + 1n >= confirmations;

      if (inv.status === "expired") {
        if (confirmed) await onLatePayment(inv, payment);
        continue;
      }

      if (inv.expired && inv.status === "pending") {
        if (confirmed) await onLatePayment(inv, payment);
        else if (payment === null) await expireInvoice(inv);
        // else: unconfirmed late deposit, wait for confirmations
        continue;
      }

      if (confirmed) {
        await onConfirmed(inv, payment);
        continue;
      }

      // An underpayment from the buyer's attached wallet is attributed and held. It never auto-
      // fulfills; the buyer sees the shortfall and either tops up via support or is refunded after
      // the grace window.
      if (inv.status === "underpaid" && inv.past_grace) {
        await onUnderpaidExpired(inv);
        continue;
      }

      if (payment === null && (inv.status === "pending" || inv.status === "seen")) {
        const under = await underpaymentFor(inv, amount, head);
        if (under && head - under.block + 1n >= confirmations) {
          await markUnderpaid({
            invoiceId: inv.id,
            received: under.received.toString(),
            payer: under.payer,
            txHash: under.txHash,
          });
          logger.warn(
            { invoiceId: inv.id, orderId: inv.order_id, received: under.received.toString(), amount: inv.amount },
            "underpayment detected and held",
          );
          continue;
        }
      }

      if (payment !== null && inv.status === "pending") {
        await db.query("UPDATE invoices SET status = 'seen' WHERE id = $1", [inv.id]);
      }
    } catch (err) {
      logger.error({ err, invoiceId: inv.id }, "payment check failed");
    }
  }
}
