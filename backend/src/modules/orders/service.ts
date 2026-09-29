import { db, tx, type Queryable } from "../../db/pool.js";
import { decryptJson, encryptJson, generateOrderKey, hashOrderKey, verifyOrderKey } from "../../lib/crypto.js";
import { badRequest, notFound, unauthorized } from "../../lib/errors.js";
import { encryptionKey } from "../../lib/keys.js";
import type { RequiredField } from "../../suppliers/types.js";
import { getProduct } from "../catalog/service.js";
import { createInvoice, type Invoice } from "../payments/invoices.js";
import type { PayAsset } from "../payments/assets.js";
import { allowedFrom, type OrderStatus } from "./status.js";

export interface CreateOrderInput {
  productId: string;
  fields: Record<string, string>;
  payAsset: PayAsset;
  wallet?: string;
}

/** Only the fields the product requires are accepted and stored. */
export function pickRequiredFields(required: RequiredField[], fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of required) {
    const v = fields[f.name]?.trim();
    if (!v) {
      if (f.optional) continue;
      throw badRequest(`missing field: ${f.name}`);
    }
    if (f.type === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw badRequest(`invalid email: ${f.name}`);
    if (f.type === "select" && !f.options?.some((o) => o.value === v)) throw badRequest(`invalid option for ${f.name}`);
    if (f.type === "number" && !Number.isFinite(Number(v))) throw badRequest(`invalid number: ${f.name}`);
    out[f.name] = v;
  }
  return out;
}

export async function createOrder(input: CreateOrderInput): Promise<{ orderId: string; orderKey: string; invoice: Invoice }> {
  const product = await getProduct(input.productId);
  if (!product) throw notFound("product");
  const fields = pickRequiredFields(product.required_fields, input.fields);
  const orderKey = generateOrderKey();

  return tx(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO orders (product_id, order_key_hash, wallet_address, customer_fields, price_usd, status)
       VALUES ($1, $2, $3, $4, $5, 'awaiting_payment') RETURNING id`,
      [
        product.id,
        hashOrderKey(orderKey),
        input.wallet?.toLowerCase() ?? null,
        Object.keys(fields).length ? encryptJson(fields, encryptionKey) : null,
        product.price_usd,
      ],
    );
    const orderId = rows[0]!.id;
    const invoice = await createInvoice(client, orderId, Number(product.price_usd), input.payAsset);
    return { orderId, orderKey, invoice };
  });
}

/** Atomic guarded status change: applies only if the current status may move to `to`. False on no-op. */
export async function transition(q: Queryable, orderId: string, to: OrderStatus): Promise<boolean> {
  const { rowCount } = await q.query(
    "UPDATE orders SET status = $2, updated_at = now() WHERE id = $1 AND status = ANY($3::text[])",
    [orderId, to, allowedFrom(to)],
  );
  return rowCount === 1;
}

interface OrderRow {
  id: string;
  product_id: string;
  title: string;
  order_key_hash: string;
  wallet_address: string | null;
  price_usd: string;
  status: OrderStatus;
  created_at: Date;
}

const ORDER_SELECT = `
  SELECT o.id, o.product_id, p.title, o.order_key_hash, o.wallet_address, o.price_usd, o.status, o.created_at
  FROM orders o JOIN products p ON p.id = o.product_id`;

async function loadOrderView(order: OrderRow) {
  const [{ rows: invoices }, { rows: deliverables }] = await Promise.all([
    db.query(
      `SELECT asset, amount, pay_to, payment_ref, expires_at, tx_hash, confirmations, status
       FROM invoices WHERE order_id = $1`,
      [order.id],
    ),
    db.query<{ type: string; payload_encrypted: string; created_at: Date }>(
      "SELECT type, payload_encrypted, created_at FROM deliverables WHERE order_id = $1",
      [order.id],
    ),
  ]);
  return {
    id: order.id,
    product_id: order.product_id,
    title: order.title,
    price_usd: order.price_usd,
    status: order.status,
    created_at: order.created_at,
    invoice: invoices[0] ?? null,
    deliverables: deliverables.map((d) => ({
      type: d.type,
      payload: decryptJson<Record<string, unknown>>(d.payload_encrypted, encryptionKey),
      created_at: d.created_at,
    })),
  };
}

export async function getOrderWithKey(orderId: string, orderKey: string) {
  const { rows } = await db.query<OrderRow>(`${ORDER_SELECT} WHERE o.id = $1`, [orderId]);
  const order = rows[0];
  // same error for unknown id and wrong key: don't leak which orders exist
  if (!order || !verifyOrderKey(orderKey, order.order_key_hash)) throw unauthorized("invalid order id or key");
  return loadOrderView(order);
}

export async function getOrderForWallet(orderId: string, wallet: string) {
  const { rows } = await db.query<OrderRow>(`${ORDER_SELECT} WHERE o.id = $1 AND o.wallet_address = $2`, [
    orderId,
    wallet.toLowerCase(),
  ]);
  if (!rows[0]) throw unauthorized("invalid order id or wallet");
  return loadOrderView(rows[0]);
}

export async function listOrdersForWallet(wallet: string) {
  const { rows } = await db.query<OrderRow>(
    `${ORDER_SELECT} WHERE o.wallet_address = $1 ORDER BY o.created_at DESC LIMIT 100`,
    [wallet.toLowerCase()],
  );
  return rows.map(({ order_key_hash: _omit, ...o }) => o);
}
