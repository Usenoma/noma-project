import { getContractAddress } from "viem";
import { defineConfig } from "vitest/config";

// Staking test contracts are deployed by anvil account 3 (nonces 0..3), so their addresses are
// known before the backend config loads: NOMA, ZEC, NVDA, NomaStaking.
const STAKING_DEPLOYER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as const;
const deployed = (nonce: number) => getContractAddress({ from: STAKING_DEPLOYER, nonce: BigInt(nonce) });

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "warn",
      DATABASE_URL: "postgres://noma:noma@127.0.0.1:55442/noma_test",
      REDIS_URL: "redis://127.0.0.1:56389/1",
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      ADMIN_TOKEN: "test-admin-token-0123456789abcdef",
      CHAIN_RPC_URL: "http://127.0.0.1:58545",
      CHAIN_ID: "31337",
      PAYMENT_CONFIRMATIONS: "3",
      // Single fixed payment address (non-custodial model) = anvil account 0, also the refund wallet.
      PAYMENT_ADDRESS: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      // first contract deployed by anvil account 0 (nonce 0)
      USDG_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      // anvil account 0
      REFUND_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      REFUNDS_AUTO_ENABLED: "1",
      OVERPAY_REFUND_MIN_USD: "0.5",
      NOMA_TOKEN_ADDRESS: deployed(0),
      ZEC_TOKEN_ADDRESS: deployed(1),
      NOMA_STAKING_ADDRESS: deployed(3),
      REWARD_INDEXER_START_BLOCK: "0",
      // AI gateway: the fake OpenRouter server runs on 59999 (see test/integration/ai.test.ts).
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_BASE_URL: "http://127.0.0.1:59999",
      OPENROUTER_MODELS: "test/model",
      AI_PUBLIC_BASE_URL: "http://localhost:3101/api/ai/v1",
      AI_KEY_TTL_DAYS: "365",
      AI_MAX_TOKENS: "4096",
      AI_RESERVE_SAFETY: "1.15",
    },
  },
});
