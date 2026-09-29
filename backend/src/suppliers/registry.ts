import { createHmac } from "node:crypto";
import { config } from "../config.js";
import { encryptionKey } from "../lib/keys.js";
import { createBitLaunchAdapter } from "./bitlaunch.js";
import { createBitrefillAdapter } from "./bitrefill.js";
import { createEsimAccessAdapter } from "./esimaccess.js";
import { createMockEsimAdapter } from "./mock.js";
import { createOpenRouterAdapter } from "./openrouter.js";
import type { SupplierAdapter } from "./types.js";

/** Separate subkey so VPS root passwords are not derived from the raw encryption key. */
const bitlaunchPasswordSecret = () => createHmac("sha256", encryptionKey).update("noma/bitlaunch-password/v1").digest();

/**
 * Adapters are registered only when their credentials are present.
 * TODO: Cryptorefills, VPNResellers, IPRoyal.
 */
function build(): Map<string, SupplierAdapter> {
  const adapters: SupplierAdapter[] = [];
  if (config.ESIMACCESS_KEY) adapters.push(createEsimAccessAdapter(config.ESIMACCESS_KEY));
  if (config.BITREFILL_KEY) {
    adapters.push(
      createBitrefillAdapter(config.BITREFILL_KEY, {
        countries: config.BITREFILL_COUNTRIES,
        includeTestProducts: config.NODE_ENV !== "production",
      }),
    );
  }
  if (config.BITLAUNCH_KEY) adapters.push(createBitLaunchAdapter(config.BITLAUNCH_KEY, bitlaunchPasswordSecret()));
  if (config.OPENROUTER_PROVISIONING_KEY) adapters.push(createOpenRouterAdapter(config.OPENROUTER_PROVISIONING_KEY));
  if (config.NODE_ENV !== "production") adapters.push(createMockEsimAdapter());
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
