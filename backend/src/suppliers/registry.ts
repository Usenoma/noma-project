import { config } from "../config.js";
import { createMockEsimAdapter } from "./mock.js";
import { createOpenRouterAdapter } from "./openrouter.js";
import type { SupplierAdapter } from "./types.js";

/**
 * Adapters are registered only when their credentials are present.
 * TODO: eSIM Access, Bitrefill, Cryptorefills, BitLaunch, VPNResellers, IPRoyal.
 */
function build(): Map<string, SupplierAdapter> {
  const adapters: SupplierAdapter[] = [];
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
