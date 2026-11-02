import { logger } from "../lib/logger.js";
import type { NormalizedProduct, SupplierAdapter, SupplierStatus } from "./types.js";

const BASE = "https://api.bitrefill.com/v2";
const PAGE_SIZE = 50;

interface Page<T> {
  meta?: { _next?: string };
  data: T;
}
interface BrPackage {
  id?: string;
  package_id?: string;
  value: string;
  price: number; // in the account currency's smallest unit (satoshis for BTC accounts)
}
interface BrProduct {
  id: string;
  name: string;
  country_code: string;
  currency: string;
  in_stock: boolean;
  recipient_type?: string; // "phone_number" = mobile top-up, not a gift card
  categories?: string[];
  packages?: BrPackage[];
}
interface BrInvoice {
  id: string;
  status: string;
  /** The invoice lifecycle status and the payment status are separate fields. */
  payment?: { status: string };
  orders?: { id: string; status: string }[];
}
interface BrOrder {
  id: string;
  status: string;
  redemption_info?: string | Record<string, unknown>;
  error?: string;
}

class BitrefillError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(`bitrefill ${status} ${code ?? ""}: ${message}`);
  }
}

const FINAL_FAILED_INVOICE = new Set(["denied", "payment_error", "blocked"]);

/**
 * Bitrefill mixes units: product prices are in the account currency's major unit (dollars), while
 * the account balance is in its smallest unit (cents). Crypto accounts (BTC) use the smallest unit
 * (satoshis) for both.
 */
const FIAT_MINOR: Record<string, number> = { USD: 100, EUR: 100, GBP: 100 };
const CRYPTO_MINOR: Record<string, number> = { BTC: 1e8 };

/** Cost/face-value bounds for USD-denominated cards: outside them the price unit is wrong, so skip. */
const MIN_COST_RATIO = 0.5;
const MAX_COST_RATIO = 1.5;
const MAX_COST_USD = 5_000;

const isTopUp = (p: BrProduct) => p.recipient_type === "phone_number" || (p.categories ?? []).includes("refill");

export interface BitrefillOptions {
  /** ISO alpha-2 list; "XI" = international. Keeps catalog sync inside the 1000/h product quota. */
  countries: string[];
  includeTestProducts: boolean;
  /** Per-order URL Bitrefill calls when the invoice changes (carries our order id, payload unused). */
  webhookUrl?: (orderId: string) => string | undefined;
}

/**
 * Bitrefill gift cards, paid from the prefunded business balance.
 * The API has no idempotency key, so purchase() only creates an UNPAID invoice (repeating it
 * leaves a harmless orphan); the invoice is paid from status() once its id is stored.
 * Paying an already-paid invoice returns 404, which is treated as "already paid".
 * Credentials: BITREFILL_KEY = "<apiId>:<apiSecret>" (Business API, Basic auth)
 *           or BITREFILL_KEY = "<personalApiKey>" (Personal API, Bearer auth).
 */
export function createBitrefillAdapter(credentials: string, opts: BitrefillOptions): SupplierAdapter {
  const auth = credentials.includes(":")
    ? `Basic ${Buffer.from(credentials).toString("base64")}`
    : `Bearer ${credentials}`;
  let fx: { usdPerPrice: number; usdPerBalance: number; at: number } | undefined;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(path.startsWith("http") ? path : `${BASE}${path}`, {
      method,
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as { message?: string; error_code?: string };
    if (!res.ok) throw new BitrefillError(res.status, json.error_code, json.message ?? res.statusText);
    return json as T;
  }

  /**
   * USD rates for the account currency, cached 10 min. `usdPerPrice` converts a package price
   * (major unit) and `usdPerBalance` converts the account balance (smallest unit).
   */
  async function rates(): Promise<{ usdPerPrice: number; usdPerBalance: number }> {
    if (fx && Date.now() - fx.at < 10 * 60_000) return fx;
    const { data } = await call<Page<{ currency: string }>>("GET", "/accounts/balance");
    const currency = data.currency;
    let usdPerMajor = 1;
    if (currency !== "USD") {
      const res = await fetch(`https://api.coinbase.com/v2/exchange-rates?currency=${currency}`, {
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await res.json()) as { data: { rates: Record<string, string> } };
      usdPerMajor = Number(body.data.rates.USD);
      if (!Number.isFinite(usdPerMajor) || usdPerMajor <= 0) throw new Error(`no ${currency}/USD rate`);
    }
    const fiatMinor = FIAT_MINOR[currency];
    const cryptoMinor = CRYPTO_MINOR[currency] ?? 1;
    fx = fiatMinor
      ? { usdPerPrice: usdPerMajor, usdPerBalance: usdPerMajor / fiatMinor, at: Date.now() }
      : { usdPerPrice: usdPerMajor / cryptoMinor, usdPerBalance: usdPerMajor / cryptoMinor, at: Date.now() };
    return fx;
  }

  const packageId = (p: BrPackage) => p.package_id ?? p.id ?? "";

  return {
    id: "bitrefill",
    name: "Bitrefill",
    category: "giftcard",
    catalogTtlMinutes: 6 * 60,

    async syncCatalog() {
      const { usdPerPrice } = await rates();
      const products: NormalizedProduct[] = [];
      let skipped = 0;
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        country: opts.countries.join(","),
        type: "gift_card",
        include_test_products: String(opts.includeTestProducts),
      });
      let next: string | undefined = `/products?${params}`;
      while (next) {
        const page: Page<BrProduct[]> = await call("GET", next);
        for (const p of page.data) {
          if (!p.in_stock || isTopUp(p)) continue;
          for (const pkg of p.packages ?? []) {
            const pid = packageId(pkg);
            if (!pid) continue;
            const costUsd = Math.round(pkg.price * usdPerPrice * 100) / 100;
            const face = Number(pkg.value);
            const ratio = costUsd / face;
            if (costUsd <= 0 || costUsd > MAX_COST_USD || (p.currency === "USD" && (ratio < MIN_COST_RATIO || ratio > MAX_COST_RATIO))) {
              skipped++;
              continue;
            }
            products.push({
              supplierSku: `${p.id}|${pid}`,
              category: "giftcard",
              title: `${p.name} ${pkg.value} ${p.currency}`,
              region: p.country_code && p.country_code !== "XI" ? p.country_code.toUpperCase() : null,
              specs: { brand: p.name, face_value: Number(pkg.value), face_currency: p.currency, product_id: p.id },
              costUsd,
              requiredFields: [],
            });
          }
        }
        next = page.meta?._next;
      }
      if (skipped) logger.warn({ skipped }, "bitrefill: packages skipped by price sanity check");
      return products;
    },

    async quote(sku) {
      const [productId, pid] = sku.split("|");
      const { data } = await call<Page<BrProduct>>("GET", `/products/${productId}`);
      const pkg = data.packages?.find((p) => packageId(p) === pid);
      if (!pkg) throw new Error(`bitrefill package ${sku} not found`);
      const { usdPerPrice } = await rates();
      return { costUsd: pkg.price * usdPerPrice };
    },

    async purchase(sku, _fields, idempotencyKey) {
      const [productId, pid] = sku.split("|");
      const webhookUrl = opts.webhookUrl?.(idempotencyKey);
      const { data } = await call<Page<BrInvoice>>("POST", "/invoices", {
        products: [{ product_id: productId, package_id: pid, quantity: 1 }],
        payment_method: "balance",
        auto_pay: false,
        ...(webhookUrl ? { webhook_url: webhookUrl } : {}),
      });
      return { supplierOrderId: data.id };
    },

    async status(invoiceId): Promise<SupplierStatus> {
      const { data: inv } = await call<Page<BrInvoice>>("GET", `/invoices/${invoiceId}`);
      // An invoice reads "not_delivered" while its payment is still "unpaid": pay on the payment
      // status, not the invoice status.
      if (inv.payment?.status === "unpaid" || inv.status === "unpaid") {
        try {
          await call("POST", `/invoices/${invoiceId}/pay`, {});
        } catch (err) {
          // 404 = already paid (or gone): re-read on the next poll
          if (!(err instanceof BitrefillError && err.status === 404)) throw err;
        }
        return "pending";
      }
      if (FINAL_FAILED_INVOICE.has(inv.status)) return "failed";
      const order = inv.orders?.[0];
      if (order?.status === "failed" || order?.status === "refunded") return "failed";
      return order?.status === "delivered" ? "done" : "pending";
    },

    async deliverable(invoiceId) {
      const { data: inv } = await call<Page<BrInvoice>>("GET", `/invoices/${invoiceId}`);
      const orderId = inv.orders?.[0]?.id;
      if (!orderId) throw new Error(`bitrefill invoice ${invoiceId} has no order`);
      const { data: order } = await call<Page<BrOrder>>("GET", `/orders/${orderId}`);
      const info = order.redemption_info;
      return {
        type: "giftcard_code",
        payload: typeof info === "string" ? { code: info } : { ...(info ?? {}) },
      };
    },

    async balance() {
      const { data } = await call<Page<{ balance: number }>>("GET", "/accounts/balance");
      const { usdPerBalance } = await rates();
      return data.balance * usdPerBalance;
    },
  };
}
