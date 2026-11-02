import { config } from "../config.js";
import type { NormalizedProduct, SupplierAdapter, SupplierStatus } from "./types.js";
import { credits } from "../modules/ai/openrouter.js";
import { deliverableFor, issueKey } from "../modules/ai/service.js";

const TIERS_USD = [5, 10, 25, 50, 100];

/**
 * NOMA AI gateway: the platform sells prepaid NOMA API usage, not OpenRouter keys. The OpenRouter
 * key stays server-side; the buyer's key and balance live in ai_keys.
 */
export function createNomaAiAdapter(): SupplierAdapter {
  return {
    id: "noma-ai",
    name: "NOMA AI",
    category: "ai_credits",

    async syncCatalog(): Promise<NormalizedProduct[]> {
      return TIERS_USD.map((usd) => ({
        supplierSku: `ai-credits-${usd}`,
        category: "ai_credits" as const,
        title: `NOMA AI credits $${usd}`,
        region: null,
        specs: { credit_usd: usd, provider: "openrouter", models: config.OPENROUTER_MODELS },
        costUsd: usd,
        requiredFields: [],
      }));
    },

    async quote(sku) {
      return { costUsd: Number(sku.replace("ai-credits-", "")) };
    },

    async purchase(_sku, _fields, orderId) {
      const { keyId, payload } = await issueKey(orderId);
      return {
        supplierOrderId: keyId,
        deliverable: { type: "api_key", payload },
      };
    },

    async status(): Promise<SupplierStatus> {
      return "done";
    },

    async deliverable(keyId) {
      return { type: "api_key", payload: await deliverableFor(keyId) };
    },

    async balance() {
      return credits();
    },
  };
}
