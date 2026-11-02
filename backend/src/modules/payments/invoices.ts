import { randomBytes } from "node:crypto";
import type pg from "pg";
import { config } from "../../config.js";
import { chain, chainConfigured } from "../../chain/client.js";
import { assetInfo, usdPrice, usdToUnits, type PayAsset } from "./assets.js";

export interface Invoice {
  id: string;
  chain: string;
  asset: PayAsset;
  amount: string;
  pay_to: string;
  payment_ref: string;
  expires_at: Date;
  status: string;
}

/**
 * Locks the price for INVOICE_TTL_MINUTES and points the buyer at the single fixed
 * payment address. There is no per-invoice deposit address and no custody: the buyer
 * pays wallet-to-wallet to `PAYMENT_ADDRESS`, and the invoice is identified by a
 * unique amount (the last 3 base units differ per invoice) matched by the watcher.
 */
export async function createInvoice(
  client: pg.PoolClient,
  orderId: string,
  priceUsd: number,
  asset: PayAsset,
): Promise<Invoice> {
  if (!config.PAYMENT_ADDRESS) throw new Error("PAYMENT_ADDRESS not configured");
  const info = assetInfo(asset);
  const base = usdToUnits(priceUsd, await usdPrice(asset), info.decimals);

  const { rows: seq } = await client.query<{ n: string }>("SELECT nextval('invoice_address_index_seq') AS n");
  const index = BigInt(seq[0]!.n);
  // Unique amount: the trailing 3 base units carry the invoice index, so two orders for the
  // same price never collide and the watcher can attribute a payment to exactly one invoice.
  const amount = base + (index % 1000n);

  const startBlock = chainConfigured ? await chain().getBlockNumber().catch(() => null) : null;
  const paymentRef = `inv_${randomBytes(9).toString("base64url")}`;

  const { rows } = await client.query<Invoice>(
    `INSERT INTO invoices (order_id, chain, asset, amount, pay_to, address_index, payment_ref, expires_at, start_block)
     VALUES ($1, 'robinhood', $2, $3, $4, $5, $6, now() + make_interval(mins => $7), $8)
     RETURNING id, chain, asset, amount, pay_to, payment_ref, expires_at, status`,
    [orderId, asset, amount.toString(), config.PAYMENT_ADDRESS, index.toString(), paymentRef, config.INVOICE_TTL_MINUTES, startBlock?.toString() ?? null],
  );
  return rows[0]!;
}
