import { createConfig, http } from "wagmi";
import { defineChain } from "viem";
import { injected, walletConnect } from "wagmi/connectors";

// Robinhood Chain — EVM. Chain id/RPC come from env once published.
const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "1");
const rpcUrl = process.env.NEXT_PUBLIC_CHAIN_RPC_URL ?? "";

// WalletConnect (mobile apps / QR) needs a free project id from cloud.walletconnect.com.
// Without it the connector is omitted and the site falls back to the injected wallet only.
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

export const robinhoodChain = defineChain({
  id: chainId,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl || "http://localhost:8545"] } },
});

export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  connectors: [
    injected(),
    ...(walletConnectProjectId
      ? [
          walletConnect({
            projectId: walletConnectProjectId,
            showQrModal: true,
            metadata: {
              name: "NOMA",
              description: "Private commerce for digital services on Robinhood Chain",
              url: "https://usenoma.org",
              icons: ["https://usenoma.org/icon.jpg"],
            },
          }),
        ]
      : []),
  ],
  transports: { [robinhoodChain.id]: http(rpcUrl || undefined) },
  ssr: true,
});
