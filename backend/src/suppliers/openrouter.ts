import type { SupplierAdapter } from "./types.js";

const BASE = "https://openrouter.ai/api/v1";
const DENOMINATIONS_USD = [5, 10, 25, 50, 100];

/**
 * AI credits via OpenRouter provisioning keys: each purchase creates a new API key whose
 * credit limit equals the purchased amount. The key is the deliverable (shown once).
 * TODO: confirm resale terms with OpenRouter and verify request/response shapes against their docs.
 */
export function createOpenRouterAdapter(provisioningKey: string): SupplierAdapter {
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${provisioningKey}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!res.ok) throw new Error(`openrouter ${path} ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  return {
    id: "openrouter",
    name: "OpenRouter",
    category: "ai_credits",
    async syncCatalog() {
      return DENOMINATIONS_USD.map((usd) => ({
        supplierSku: `credits-${usd}`,
        category: "ai_credits" as const,
        title: `AI credits $${usd} (OpenRouter key, 300+ models)`,
        region: null,
        specs: { credit_usd: usd, provider: "openrouter" },
        costUsd: usd,
        requiredFields: [],
      }));
    },
    async quote(sku) {
      return { costUsd: Number(sku.replace("credits-", "")) };
    },
    async purchase(sku, _fields, idempotencyKey) {
      const limit = Number(sku.replace("credits-", ""));
      // name doubles as idempotency marker so a retried job can be reconciled manually
      const res = await call<{ key: string; data: { hash: string } }>("/keys", {
        method: "POST",
        body: JSON.stringify({ name: `noma-${idempotencyKey}`, limit }),
      });
      return {
        supplierOrderId: res.data.hash,
        deliverable: { type: "api_key", payload: { api_key: res.key, base_url: BASE } },
      };
    },
    async status() {
      return "done";
    },
    async deliverable() {
      throw new Error("OpenRouter keys are only returned at creation (see purchase)");
    },
    async balance() {
      const res = await call<{ data: { total_credits: number; total_usage: number } }>("/credits");
      return res.data.total_credits - res.data.total_usage;
    },
  };
}
