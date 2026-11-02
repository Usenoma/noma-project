import { db, tx, type Queryable } from "../../db/pool.js";
import { decryptJson, encryptJson, generateOrderKey, hashOrderKey, verifyOrderKey } from "../../lib/crypto.js";
import { badRequest, HttpError, notFound, unauthorized } from "../../lib/errors.js";
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

  // Do not take money for an order the supplier's current balance cannot cover. The balance is
  // refreshed every 5 minutes; a race is still possible and is handled by the refund path.
  const stock = await db.query<{ cost_usd: string; balance_usd: string | null }>(
    `SELECT p.cost_usd, s.balance_usd
     FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE p.id = $1`,
    [product.id],
  );
  const supplier = stock.rows[0];
  if (supplier?.balance_usd != null && Number(supplier.balance_usd) < Number(supplier.cost_usd)) {
    throw new HttpError(503, "supplier is temporarily out of stock; try again later");
  }

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
  has_deliverable: boolean;
}

const ORDER_SELECT = `
  SELECT o.id, o.product_id, p.title, o.order_key_hash, o.wallet_address, o.price_usd, o.status,
         o.created_at,
         EXISTS (SELECT 1 FROM deliverables d WHERE d.order_id = o.id) AS has_deliverable
  FROM orders o
  JOIN products p ON p.id = o.product_id
  LEFT JOIN invoices i ON i.order_id = o.id`;

async function loadOrderView(order: OrderRow) {
  const [{ rows: invoices }, { rows: deliverables }, { rows: refunds }, { rows: claims }] = await Promise.all([
    db.query(
      `SELECT asset, amount, pay_to, payment_ref, expires_at, tx_hash, confirmations, status,
              received, payer_address
       FROM invoices WHERE order_id = $1`,
      [order.id],
    ),
    db.query<{ type: string; payload_encrypted: string; created_at: Date }>(
      "SELECT type, payload_encrypted, created_at FROM deliverables WHERE order_id = $1",
      [order.id],
    ),
    db.query(
      `SELECT id, kind, amount, asset, to_address, tx_hash, status, created_at
       FROM refunds WHERE order_id = $1 ORDER BY created_at`,
      [order.id],
    ),
    db.query(
      `SELECT id, order_id, tx_hash, asset, amount, payer_address, status, note, created_at, resolved_at
       FROM payment_claims WHERE order_id = $1 ORDER BY created_at DESC`,
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
    refunds,
    payment_claims: claims,
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
  // The payer address is written by the on-chain watcher, so a buyer who paid from a wallet can
  // reopen the order even if they did not opt into attaching it at checkout.
  const { rows } = await db.query<OrderRow>(
    `${ORDER_SELECT}
     WHERE o.id = $1
       AND (lower(o.wallet_address) = $2 OR lower(i.payer_address) = $2)`,
    [orderId, wallet.toLowerCase()],
  );
  if (!rows[0]) throw unauthorized("invalid order id or wallet");
  return loadOrderView(rows[0]);
}

export interface OrderListOptions {
  limit?: number;
  offset?: number;
}

export async function listOrdersForWallet(wallet: string, opts: OrderListOptions = {}) {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20), 1), 100);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const normalized = wallet.toLowerCase();

  const [{ rows }, { rows: counted }] = await Promise.all([
    db.query<OrderRow>(
      `${ORDER_SELECT}
       WHERE (lower(o.wallet_address) = $1 OR lower(i.payer_address) = $1)
       ORDER BY o.created_at DESC
       LIMIT $2 OFFSET $3`,
      [normalized, limit, offset],
    ),
    db.query<{ total: string; spend_usd: string }>(
      `SELECT count(*)::text AS total, COALESCE(sum(o.price_usd), 0)::text AS spend_usd
       FROM orders o
       LEFT JOIN invoices i ON i.order_id = o.id
       WHERE (lower(o.wallet_address) = $1 OR lower(i.payer_address) = $1)`,
      [normalized],
    ),
  ]);

  return {
    orders: rows.map(({ order_key_hash: _omit, ...order }) => order),
    total: Number(counted[0]?.total ?? 0),
    spend_usd: counted[0]?.spend_usd ?? "0",
    limit,
    offset,
  };
}
