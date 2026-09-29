import type { Address } from "viem";
import { config } from "../../config.js";
import { chain } from "../../chain/client.js";
import { erc20Abi } from "../../chain/abis/index.js";
import { db, tx } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { QUEUE, queue } from "../../queues.js";
import { transition } from "../orders/service.js";
import { assetInfo, type PayAsset } from "./assets.js";

interface OpenInvoice {
  id: string;
  order_id: string;
  asset: PayAsset;
  amount: string;
  pay_to: Address;
  status: "pending" | "seen" | "underpaid";
  expired: boolean;
}

/** How far back to look for the ERC-20 Transfer that identifies the payer (for refunds). */
const PAYER_LOOKBACK_BLOCKS = 50_000n;

async function balanceAt(asset: PayAsset, holder: Address, blockNumber: bigint): Promise<bigint> {
  const info = assetInfo(asset);
  return info.token
    ? chain().readContract({ address: info.token, abi: erc20Abi, functionName: "balanceOf", args: [holder], blockNumber })
    : chain().getBalance({ address: holder, blockNumber });
}

/** Payer of an ERC-20 payment = sender of the latest Transfer into the deposit address. Native ETH: unknown here. */
async function findPayer(asset: PayAsset, payTo: Address, head: bigint): Promise<{ payer: Address; txHash: string } | null> {
  const info = assetInfo(asset);
  if (!info.token) return null; // TODO: native ETH payer via trace/tx scan
  const logs = await chain().getContractEvents({
    address: info.token,
    abi: erc20Abi,
    eventName: "Transfer",
    args: { to: payTo },
    fromBlock: head > PAYER_LOOKBACK_BLOCKS ? head - PAYER_LOOKBACK_BLOCKS : 0n,
    toBlock: head,
  });
  const last = logs.at(-1);
  return last?.args.from ? { payer: last.args.from, txHash: last.transactionHash } : null;
}

/**
 * One pass over open invoices. Deposit addresses are unique per invoice, so the balance of the
 * address is the amount paid. "Confirmed" = balance at (head - confirmations + 1) covers the amount.
 */
export async function watchPayments(): Promise<void> {
  const head = await chain().getBlockNumber();
  const confirmedBlock = head - BigInt(config.PAYMENT_CONFIRMATIONS) + 1n;

  const { rows } = await db.query<OpenInvoice>(
    `SELECT id, order_id, asset, amount, pay_to, status, expires_at < now() AS expired
     FROM invoices WHERE status IN ('pending', 'seen', 'underpaid')`,
  );

  for (const inv of rows) {
    try {
      const amount = BigInt(inv.amount);
      const [atHead, atConfirmed] = await Promise.all([
        balanceAt(inv.asset, inv.pay_to, head),
        balanceAt(inv.asset, inv.pay_to, confirmedBlock),
      ]);

      if (atConfirmed >= amount) {
        const payer = await findPayer(inv.asset, inv.pay_to, head);
        const paid = await tx(async (client) => {
          await client.query(
            `UPDATE invoices SET status = 'confirmed', received = $2, confirmations = $3,
               payer_address = $4, tx_hash = $5 WHERE id = $1`,
            [inv.id, atConfirmed.toString(), config.PAYMENT_CONFIRMATIONS, payer?.payer.toLowerCase() ?? null, payer?.txHash ?? null],
          );
          return transition(client, inv.order_id, "paid");
        });
        if (paid) {
          await queue(QUEUE.fulfillment).add("fulfill", { orderId: inv.order_id }, { jobId: `fulfill-${inv.order_id}` });
          logger.info({ orderId: inv.order_id, overpaid: (atConfirmed - amount).toString() }, "invoice paid");
          // TODO: overpayment (atConfirmed > amount) → credit or refund the difference
        }
        continue;
      }

      if (atHead > 0n) {
        // underpaid invoices are held (never auto-expired) until topped up or handled by admin
        const status = atHead >= amount ? "seen" : "underpaid";
        await db.query("UPDATE invoices SET status = $2, received = $3 WHERE id = $1", [inv.id, status, atHead.toString()]);
        continue;
      }

      if (inv.expired) {
        await tx(async (client) => {
          await client.query("UPDATE invoices SET status = 'expired' WHERE id = $1", [inv.id]);
          await transition(client, inv.order_id, "expired");
        });
      }
    } catch (err) {
      logger.error({ err, invoiceId: inv.id }, "payment check failed");
    }
  }
}
