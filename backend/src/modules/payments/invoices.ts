import { randomBytes } from "node:crypto";
import type pg from "pg";
import { config } from "../../config.js";
import { chain, chainConfigured } from "../../chain/client.js";
import { depositAddress } from "../../chain/depositAddress.js";
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

/** Locks the price for INVOICE_TTL_MINUTES and assigns a unique deposit address. */
export async function createInvoice(
  client: pg.PoolClient,
  orderId: string,
  priceUsd: number,
  asset: PayAsset,
): Promise<Invoice> {
  const info = assetInfo(asset);
  const amount = usdToUnits(priceUsd, await usdPrice(asset), info.decimals);

  const { rows: seq } = await client.query<{ n: string }>("SELECT nextval('invoice_address_index_seq') AS n");
  const index = BigInt(seq[0]!.n);
  const payTo = depositAddress(index);
  // best effort: only narrows the payer search; order creation must not depend on the RPC
  const startBlock = chainConfigured ? await chain().getBlockNumber().catch(() => null) : null;
  const paymentRef = `inv_${randomBytes(9).toString("base64url")}`;

  const { rows } = await client.query<Invoice>(
    `INSERT INTO invoices (order_id, chain, asset, amount, pay_to, address_index, payment_ref, expires_at, start_block)
     VALUES ($1, 'robinhood', $2, $3, $4, $5, $6, now() + make_interval(mins => $7), $8)
     RETURNING id, chain, asset, amount, pay_to, payment_ref, expires_at, status`,
    [orderId, asset, amount.toString(), payTo, index.toString(), paymentRef, config.INVOICE_TTL_MINUTES, startBlock?.toString() ?? null],
  );
  return rows[0]!;
}
