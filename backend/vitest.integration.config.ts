import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "viem/accounts";
import { defineConfig } from "vitest/config";

// Anvil's well-known dev mnemonic. Deposit addresses use account 1' so they never collide
// with the funded anvil accounts (m/44'/60'/0'/0/i) used as payer / refund wallet.
const MNEMONIC = "test test test test test test test test test test test junk";
const xpub = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive("m/44'/60'/1'/0").publicExtendedKey;

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
      PAYMENT_XPUB: xpub,
      // first contract deployed by anvil account 0 (nonce 0)
      USDC_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      // anvil account 0
      REFUND_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      OVERPAY_REFUND_MIN_USD: "0.5",
    },
  },
});
