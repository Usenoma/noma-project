import { createConfig, http } from "wagmi";
import { defineChain } from "viem";
import { injected } from "wagmi/connectors";

// Robinhood Chain — EVM. Chain id/RPC come from env once published.
const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "1");
const rpcUrl = process.env.NEXT_PUBLIC_CHAIN_RPC_URL ?? "";

export const robinhoodChain = defineChain({
  id: chainId,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl || "http://localhost:8545"] } },
});

export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  connectors: [injected()],
  transports: { [robinhoodChain.id]: http(rpcUrl || undefined) },
  ssr: true,
});
