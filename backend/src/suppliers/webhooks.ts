import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { encryptionKey } from "../lib/keys.js";

/** Per-supplier URL secret, derived from the encryption key so nothing extra has to be provisioned. */
export function webhookToken(supplierId: string): string {
  return createHmac("sha256", encryptionKey).update(`noma/supplier-webhook/v1/${supplierId}`).digest("hex");
}

export function webhookTokenMatches(supplierId: string, given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(webhookToken(supplierId));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * URL a supplier calls when an order changes; undefined until PUBLIC_API_URL is set.
 * With `orderId` (our order id) the notification needs no payload at all: used by suppliers that
 * take a webhook URL per order.
 */
export function webhookUrl(supplierId: string, orderId?: string): string | undefined {
  if (!config.PUBLIC_API_URL) return undefined;
  const base = config.PUBLIC_API_URL.replace(/\/+$/, "");
  return `${base}/webhooks/suppliers/${supplierId}/${webhookToken(supplierId)}${orderId ? `?order=${orderId}` : ""}`;
}
