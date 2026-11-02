"use client";

import dynamic from "next/dynamic";

/**
 * Lazily loads the wagmi provider so pages without wallet features (home, market, catalog,
 * docs…) never download wagmi/viem. Pages that DO use wallet features render this scope and
 * get the wallet stack with their own route bundle — no extra wait after hydration.
 */
const WagmiProviders = dynamic(() => import("./WagmiProviders").then((m) => m.WagmiProviders));

export function WalletScope({ children }: { children: React.ReactNode }) {
  return <WagmiProviders>{children}</WagmiProviders>;
}
