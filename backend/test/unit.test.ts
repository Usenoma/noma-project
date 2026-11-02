import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { decrypt, encrypt, generateOrderKey, hashOrderKey, verifyOrderKey } from "../src/lib/crypto.js";
import { verifyWalletAuth, walletAuthMessage } from "../src/lib/walletAuth.js";
import { issueWalletSession, verifyWalletSession } from "../src/lib/walletSession.js";
import { applyMarkup } from "../src/modules/catalog/pricing.js";
import { usdToUnits } from "../src/modules/payments/units.js";
import { creatorFeeShare, cyclePool, pendingCreatorPayout } from "../src/modules/rewards/poolMath.js";
import { rawToUsd } from "../src/modules/rewards/quoteAsset.js";
import { allowedFrom, canTransition } from "../src/modules/orders/status.js";
import { combineQuotes } from "../src/modules/payments/priceFeed.js";
import { pickRequiredFields } from "../src/modules/orders/service.js";
import { formatAlert } from "../src/lib/alerts.js";
import { failureRateExceeded, quietSeconds } from "../src/modules/health/monitor.js";
import { aliasValues } from "../src/modules/identity/service.js";
import { recommend } from "../src/modules/subscriptions/service.js";

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
    expect(cyclePool(7n, 4n, 3n).total).toBe(14n);
  });

  it("matches the Pons creator split (1% fee, 30% protocol share, 1% tax)", () => {
    // 1 ETH trade: fee 0.01, tax 0.01 → creator 0.007 + 0.01
    const fee = 10n ** 16n;
    expect(creatorFeeShare(fee, 3000n)).toBe(7n * 10n ** 15n);
    expect(pendingCreatorPayout(fee, fee, 3000n)).toBe(17n * 10n ** 15n);
    // protocol share rounds down, so the creator keeps the odd unit (as in Pons _sweepFees)
    expect(creatorFeeShare(7n, 3000n)).toBe(5n);
    expect(pendingCreatorPayout(0n, 0n, 3000n)).toBe(0n);
  });

  it("values the quote asset with its own decimals", () => {
    expect(rawToUsd(17n * 10n ** 15n, 18, 3000)).toBe("51.000000"); // 0.017 ETH
    expect(rawToUsd(51_000_000n, 6, 1)).toBe("51.000000"); // a 6-decimal pair token such as USDC
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

  it("issues read-only sessions that expire and reject tampering", () => {
    const address = `0x8E4f${"0".repeat(32)}5FFe`;
    const now = Date.UTC(2026, 0, 1);
    const session = issueWalletSession(address, now);
    expect(session.address).toBe(address.toLowerCase());
    expect(verifyWalletSession(session.token, now + 1000)).toBe(address.toLowerCase());
    expect(verifyWalletSession(session.token, Date.parse(session.expires_at) + 1)).toBeNull();
    expect(verifyWalletSession(session.token.replace("noma_ws_", "noma_ws_x"), now)).toBeNull();
    expect(verifyWalletSession("noma_ws_invalid", now)).toBeNull();
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

describe("alerts", () => {
  it("formats a plain-text body, skipping empty details", () => {
    const text = formatAlert("action", "Safe owners: sign", { cycleId: 3, safeTxHash: "0xab", skipped: undefined, none: null, obj: { n: 1n } });
    expect(text).toBe(`[NOMA test] ACTION: Safe owners: sign
cycleId: 3
safeTxHash: 0xab
obj: {"n":"1"}`);
  });
});

describe("health monitor", () => {
  it("flags a fulfillment failure rate only with enough failures", () => {
    expect(failureRateExceeded(2, 0)).toBe(false); // too few to matter
    expect(failureRateExceeded(3, 9)).toBe(true); // 25%
    expect(failureRateExceeded(3, 10)).toBe(false);
  });

  it("measures poller silence from the later of last pass and process start", () => {
    const start = 1_000_000;
    expect(quietSeconds(null, start + 60_000, start)).toBe(60);
    expect(quietSeconds(start - 86_400_000, start + 30_000, start)).toBe(30); // stale key from before a restart
    expect(quietSeconds(start + 50_000, start + 80_000, start)).toBe(30);
  });
});

describe("ghost checkout aliases", () => {
  it("keeps delivery email real and aliases other provided fields", () => {
    const required = [
      { name: "email", label: "Email", type: "email" as const },
      { name: "username", label: "Username", type: "string" as const },
      { name: "country", label: "Country", type: "country" as const },
    ];
    const { fields, aliases } = aliasValues(
      required,
      { email: "real@example.com", username: "alice" },
      "abc123",
    );

    expect(fields.email).toBe("real@example.com"); // delivery stays real
    expect(fields.username).toBe("noma-abc123-username"); // aliased
    expect(fields.country).toBeUndefined(); // not provided → not sent
    expect(aliases.find((a) => a.field === "email")?.aliased).toBe(false);
    expect(aliases.find((a) => a.field === "username")?.aliased).toBe(true);
  });
});

describe("subscription recommendations", () => {
  const base = {
    id: "s1",
    owner: "0x0000000000000000000000000000000000000000",
    service: "VPN 30 days",
    supplier_id: null,
    renewal_at: null,
    price_usd: null,
    status: "active" as const,
    last_seen_at: null,
  };
  const now = Date.UTC(2026, 0, 1);

  it("flags stale usage", () => {
    const seen = new Date(now - 50 * 86_400_000).toISOString();
    expect(recommend({ ...base, last_seen_at: seen }, now)).toBe("unused? no login in 50 days");
  });

  it("flags an imminent renewal", () => {
    const renewal = new Date(now + 2 * 86_400_000).toISOString();
    expect(recommend({ ...base, renewal_at: renewal }, now)).toBe("renews in 2 days");
  });

  it("says nothing without evidence, and nothing for a finished subscription", () => {
    expect(recommend(base, now)).toBeNull();
    expect(recommend({ ...base, status: "cancelled" }, now)).toBeNull();
  });
});
