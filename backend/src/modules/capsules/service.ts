import { randomUUID } from "node:crypto";
import { db } from "../../db/pool.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { createOrder } from "../orders/service.js";
import type { PayAsset } from "../payments/assets.js";
import type { RequiredField } from "../../suppliers/types.js";

export interface CapsuleItemView {
  category: string;
  title: string;
  product: { id: string; title: string; price_usd: string; required_fields: RequiredField[] } | null;
}

export interface CapsuleView {
  slug: string;
  title: string;
  outcome: string;
  items: CapsuleItemView[];
  total_usd: string;
  available: boolean;
}

interface CapsuleRow {
  id: string;
  slug: string;
  title: string;
  outcome: string;
}

async function itemsFor(capsuleId: string): Promise<CapsuleItemView[]> {
  const { rows } = await db.query<{ category: string; title: string }>(
    "SELECT category, title FROM capsule_items WHERE capsule_id = $1 ORDER BY position",
    [capsuleId],
  );
  const items: CapsuleItemView[] = [];
  for (const row of rows) {
    const { rows: products } = await db.query<{
      id: string;
      title: string;
      price_usd: string;
      required_fields: RequiredField[];
    }>(
      "SELECT id, title, price_usd, required_fields FROM products WHERE category = $1 AND active = true ORDER BY price_usd ASC LIMIT 1",
      [row.category],
    );
    items.push({ category: row.category, title: row.title, product: products[0] ?? null });
  }
  return items;
}

function view(c: CapsuleRow, items: CapsuleItemView[]): CapsuleView {
  const total = items.reduce((sum, i) => sum + (i.product ? Number(i.product.price_usd) : 0), 0);
  return {
    slug: c.slug,
    title: c.title,
    outcome: c.outcome,
    items,
    total_usd: total.toFixed(2),
    available: items.length > 0 && items.every((i) => i.product !== null),
  };
}

export async function listCapsules(): Promise<CapsuleView[]> {
  const { rows } = await db.query<CapsuleRow>(
    "SELECT id, slug, title, outcome FROM capsules WHERE active = true ORDER BY title",
  );
  const out: CapsuleView[] = [];
  for (const c of rows) out.push(view(c, await itemsFor(c.id)));
  return out;
}

export async function getCapsule(slug: string): Promise<CapsuleView> {
  const { rows } = await db.query<CapsuleRow>(
    "SELECT id, slug, title, outcome FROM capsules WHERE slug = $1 AND active = true",
    [slug],
  );
  const c = rows[0];
  if (!c) throw notFound("capsule");
  return view(c, await itemsFor(c.id));
}

export interface CapsuleOrder {
  order_id: string;
  order_key: string;
  item: string;
  invoice: { asset: string; amount: string; pay_to: string; payment_ref: string; expires_at: Date };
}

/**
 * Buy the outcome: creates one order per item (one click, one order per included service).
 * Each order carries its own invoice; the buyer pays them individually. An item that fails only
 * affects its own order — the rest of the capsule stands. group_id ties the orders of one purchase.
 */
export async function buyCapsule(
  slug: string,
  fields: Record<string, string>,
  payAsset: PayAsset,
  wallet?: string,
): Promise<{ slug: string; group_id: string; orders: CapsuleOrder[] }> {
  const capsule = await getCapsule(slug);
  if (!capsule.available) throw badRequest("capsule unavailable");
  const { rows: capsuleIds } = await db.query<{ id: string }>(
    "SELECT id FROM capsules WHERE slug = $1 AND active = true",
    [slug],
  );
  const capsuleId = capsuleIds[0]?.id;
  if (!capsuleId) throw notFound("capsule");

  const groupId = randomUUID();
  const orders: CapsuleOrder[] = [];
  for (const item of capsule.items) {
    const { orderId, orderKey, invoice } = await createOrder({
      productId: item.product!.id,
      fields,
      payAsset,
      wallet,
    });
    await db.query("INSERT INTO capsule_orders (capsule_id, order_id, group_id) VALUES ($1, $2, $3)", [
      capsuleId,
      orderId,
      groupId,
    ]);
    orders.push({ order_id: orderId, order_key: orderKey, item: item.title, invoice });
  }
  return { slug: capsule.slug, group_id: groupId, orders };
}
