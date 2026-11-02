import { randomBytes } from "node:crypto";
import { notFound } from "../../lib/errors.js";
import type { RequiredField } from "../../suppliers/types.js";
import { getProduct } from "../catalog/service.js";

export interface AliasPreview {
  field: string;
  label: string;
  real: string;
  sent: string;
  aliased: boolean;
}

/** Fields that carry the delivery itself must stay real — the buyer has to receive the order. */
const DELIVERY_FIELD = /email|mail/i;

/**
 * Pure core of Ghost Checkout v1: map one order's provided fields to what the supplier will see.
 * Delivery-critical fields (email) stay real; every other provided field gets a per-order alias
 * tagged with `tag`. Exported so the mapping can be tested without a database.
 */
export function aliasValues(
  required: RequiredField[],
  fields: Record<string, string>,
  tag: string,
): { fields: Record<string, string>; aliases: AliasPreview[] } {
  const sent: Record<string, string> = {};
  const aliases: AliasPreview[] = [];

  for (const f of required) {
    const real = (fields[f.name] ?? "").trim();
    if (!real) continue;
    const delivery = f.type === "email" || DELIVERY_FIELD.test(f.name);
    const value = delivery ? real : `noma-${tag}-${f.name}`;
    sent[f.name] = value;
    aliases.push({ field: f.name, label: f.label, real, sent: value, aliased: !delivery });
  }

  return { fields: sent, aliases };
}

/**
 * Ghost Checkout v1 preview for one order. The returned `fields` are what the order creation must
 * use, so the supplier never sees the real value of an aliased field.
 */
export async function previewAliases(
  productId: string,
  fields: Record<string, string>,
): Promise<{ fields: Record<string, string>; aliases: AliasPreview[] }> {
  const product = await getProduct(productId);
  if (!product) throw notFound("product");
  return aliasValues(product.required_fields, fields, randomBytes(3).toString("hex"));
}
