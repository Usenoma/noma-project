"use client";

import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";

/**
 * The real wagmi provider. Kept in its own module so the heavy wagmi/viem chunk is only
 * loaded on pages that actually use wallet features (via WalletScope).
 */
export function WagmiProviders({ children }: { children: React.ReactNode }) {
  return <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>;
}
