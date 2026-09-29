import { createPublicClient, createWalletClient, defineChain, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";

/** Robinhood Chain (EVM). RPC and chain id come from env so testnet/mainnet is a config switch. */
export const robinhoodChain = defineChain({
  id: config.CHAIN_ID ?? 0,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: config.CHAIN_RPC_URL ? [config.CHAIN_RPC_URL] : [] } },
});

export const chainConfigured = Boolean(config.CHAIN_RPC_URL && config.CHAIN_ID);

let publicClient: PublicClient | undefined;

export function chain(): PublicClient {
  if (!chainConfigured) throw new Error("CHAIN_RPC_URL / CHAIN_ID not configured");
  // cacheTime 0: watchers must read the current head, not a block number cached for seconds
  // batch: many view calls (e.g. earned() per reward asset) go out as one JSON-RPC request
  publicClient ??= createPublicClient({
    chain: robinhoodChain,
    transport: http(config.CHAIN_RPC_URL, { batch: true }),
    cacheTime: 0,
  });
  return publicClient;
}

export type NomaWallet = ReturnType<typeof walletFor>;

function walletFor(privateKey: string | undefined, role: string) {
  if (!privateKey) throw new Error(`${role} private key not configured`);
  return createWalletClient({
    account: privateKeyToAccount(privateKey as Hex),
    chain: robinhoodChain,
    transport: http(config.CHAIN_RPC_URL),
  });
}

/** Executor and refund wallets are separate keys with limited float (architecture.md §6). */
export const executorWallet = () => walletFor(config.EXECUTOR_PRIVATE_KEY, "executor");
export const refundWallet = () => walletFor(config.REFUND_PRIVATE_KEY, "refund");
