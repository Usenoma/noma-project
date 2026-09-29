import { describe, expect, it } from "vitest";
import { HDKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { mnemonicToSeedSync } from "@scure/bip39";
import { decrypt, encrypt, generateOrderKey, hashOrderKey, verifyOrderKey } from "../src/lib/crypto.js";
import { verifyWalletAuth, walletAuthMessage } from "../src/lib/walletAuth.js";
import { allocateProRata } from "../src/modules/distribution/allocation.js";
import { applyMarkup } from "../src/modules/catalog/pricing.js";
import { usdToUnits } from "../src/modules/payments/units.js";
import { cyclePool } from "../src/modules/rewards/poolMath.js";
import { allowedFrom, canTransition } from "../src/modules/orders/status.js";
import { depositAddress } from "../src/chain/depositAddress.js";
import { combineQuotes } from "../src/modules/payments/priceFeed.js";
import { pickRequiredFields } from "../src/modules/orders/service.js";

describe("crypto", () => {
  const key = Buffer.alloc(32, 1);

  it("round-trips AES-GCM and rejects tampering", () => {
    const blob = encrypt("LPA:1$secret", key);
    expect(decrypt(blob, key)).toBe("LPA:1$secret");
    const buf = Buffer.from(blob, "base64");
    buf[buf.length - 1]! ^= 1;
    expect(() => decrypt(buf.toString("base64"), key)).toThrow();
  });

  it("verifies order keys against their hash only", () => {
    const k = generateOrderKey();
    expect(k.startsWith("nok_")).toBe(true);
    expect(verifyOrderKey(k, hashOrderKey(k))).toBe(true);
    expect(verifyOrderKey(generateOrderKey(), hashOrderKey(k))).toBe(false);
  });
});

describe("reward pool math", () => {
  it("splits exactly 50/50 with no unit lost", () => {
    expect(cyclePool(7n, 4n)).toEqual({ total: 11n, zec: 5n, stock: 6n });
    const p = cyclePool(10n ** 18n, 1n);
    expect(p.zec + p.stock).toBe(p.total);
  });
});

describe("pro-rata allocation", () => {
  it("never allocates more than the total and reports dust", () => {
    const holders = [
      { address: "a", balance: 1n },
      { address: "b", balance: 1n },
      { address: "c", balance: 1n },
    ];
    const { allocations, dust } = allocateProRata(100n, holders);
    expect(allocations.map((a) => a.amount)).toEqual([33n, 33n, 33n]);
    expect(dust).toBe(1n);
  });

  it("handles empty supply", () => {
    expect(allocateProRata(100n, [])).toEqual({ allocations: [], dust: 100n });
  });
});

describe("order status", () => {
  it("enforces the lifecycle", () => {
    expect(canTransition("awaiting_payment", "paid")).toBe(true);
    expect(canTransition("delivered", "refunding")).toBe(false);
    expect(allowedFrom("refunding")).toEqual(["expired", "failed"]);
  });
});

describe("pricing", () => {
  it("applies category markup and rounds up to the cent", () => {
    expect(applyMarkup(10, "esim", { default: 0.08, esim: 0.12 })).toBe(11.2);
    expect(applyMarkup(9.99, "vpn", { default: 0.08 })).toBe(10.79);
  });

  it("converts USD to raw units, rounding up", () => {
    expect(usdToUnits(19.44, 1, 6)).toBe(19_440_000n);
    expect(usdToUnits(1, 3000, 18)).toBe(333_333_333_333_334n);
  });
});

describe("deposit addresses", () => {
  it("derives the same addresses from the xpub as the wallet does from the mnemonic", () => {
    const mnemonic = "test test test test test test test test test test test junk";
    const node = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive("m/44'/60'/0'/0");
    for (const i of [0, 1, 42]) {
      expect(depositAddress(BigInt(i), node.publicExtendedKey)).toBe(mnemonicToAccount(mnemonic, { addressIndex: i }).address);
    }
  });
});

describe("wallet auth", () => {
  it("accepts a fresh signature and rejects stale or foreign ones", async () => {
    const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const now = Date.now();
    const signature = await account.signMessage({ message: walletAuthMessage(account.address, now) });
    expect(await verifyWalletAuth(account.address, signature, String(now), now)).toBe(account.address);
    expect(await verifyWalletAuth(account.address, signature, String(now), now + 10 * 60_000)).toBeNull();
    const other = privateKeyToAccount(`0x${"22".repeat(32)}`).address;
    expect(await verifyWalletAuth(other, signature, String(now), now)).toBeNull();
  });
});

describe("ETH price aggregation", () => {
  it("needs two agreeing sources", () => {
    expect(combineQuotes([3000, 3010])).toBe(3005);
    expect(combineQuotes([3000])).toBeNull();
    expect(combineQuotes([3000, 3200])).toBeNull(); // >2% apart
    expect(combineQuotes([3000, NaN, 3001, 2999])).toBe(3000);
  });
});

describe("required fields", () => {
  const os = { name: "os", label: "OS", type: "select" as const, options: [{ value: "10000", label: "Ubuntu 24.04" }] };
  it("keeps only declared fields and validates selects", () => {
    expect(pickRequiredFields([os], { os: "10000", extra: "x" })).toEqual({ os: "10000" });
    expect(() => pickRequiredFields([os], { os: "rm -rf" })).toThrow(/invalid option/);
    expect(() => pickRequiredFields([os], {})).toThrow(/missing field/);
  });
});
