import { createHmac } from "node:crypto";
import { config } from "../config.js";
import { encryptionKey } from "../lib/keys.js";
import { createBitLaunchAdapter } from "./bitlaunch.js";
import { createBitrefillAdapter } from "./bitrefill.js";
import { createEsimAccessAdapter } from "./esimaccess.js";
import { createIpRoyalAdapter } from "./iproyal.js";
import { createMockAiCreditsAdapter, createMockEsimAdapter, createMockProxyAdapter, createMockVpnAdapter } from "./mock.js";
import { createNomaAiAdapter } from "./nomaAi.js";
import type { SupplierAdapter } from "./types.js";
import { createVpnResellersAdapter } from "./vpnresellers.js";
import { webhookUrl } from "./webhooks.js";

/** Separate subkeys so supplier passwords are not derived from the raw encryption key. */
const passwordSecret = (purpose: string) => createHmac("sha256", encryptionKey).update(`noma/${purpose}-password/v1`).digest();

/** Adapters are registered only when their credentials are present. */
function build(): Map<string, SupplierAdapter> {
  const adapters: SupplierAdapter[] = [];
  if (config.ESIMACCESS_KEY) adapters.push(createEsimAccessAdapter(config.ESIMACCESS_KEY));
  if (config.BITREFILL_KEY) {
    adapters.push(
      createBitrefillAdapter(config.BITREFILL_KEY, {
        countries: config.BITREFILL_COUNTRIES,
        includeTestProducts: config.NODE_ENV !== "production",
        webhookUrl: (orderId) => webhookUrl("bitrefill", orderId),
      }),
    );
  }
  if (config.BITLAUNCH_KEY) adapters.push(createBitLaunchAdapter(config.BITLAUNCH_KEY, passwordSecret("bitlaunch")));
  if (config.VPNRESELLERS_KEY) {
    adapters.push(createVpnResellersAdapter(config.VPNRESELLERS_KEY, passwordSecret("vpnresellers"), { monthlyUsd: config.VPNRESELLERS_MONTHLY_USD }));
  }
  if (config.IPROYAL_KEY) adapters.push(createIpRoyalAdapter(config.IPROYAL_KEY, passwordSecret("iproyal")));
  if (config.OPENROUTER_API_KEY) adapters.push(createNomaAiAdapter());
  if (config.NODE_ENV !== "production") {
    adapters.push(createMockEsimAdapter());
    adapters.push(createMockVpnAdapter());
    adapters.push(createMockProxyAdapter());
    adapters.push(createMockAiCreditsAdapter());
  }
  return new Map(adapters.map((a) => [a.id, a]));
}

const registry = build();

export function adapters(): SupplierAdapter[] {
  return [...registry.values()];
}

export function adapter(id: string): SupplierAdapter {
  const a = registry.get(id);
  if (!a) throw new Error(`supplier adapter '${id}' not registered`);
  return a;
}
