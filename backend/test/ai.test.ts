import { describe, expect, it } from "vitest";
import { decryptAiKey, generateAiKey, hashAiKey, validAiKey } from "../src/modules/ai/keys.js";
import {
  costFromUsage,
  estimatePromptTokens,
  reserveUsd,
  retailCost,
  round6,
} from "../src/modules/ai/pricing.js";

describe("AI gateway keys", () => {
  it("issues a NOMA key, stores only the hash, and can recover it", () => {
    const key = generateAiKey();
    expect(key.key.startsWith("noma_sk_")).toBe(true);
    expect(validAiKey(key.key)).toBe(true);
    expect(key.hash).toBe(hashAiKey(key.key));
    expect(key.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(key.last4).toHaveLength(4);
    expect(decryptAiKey(key.encrypted)).toBe(key.key);
    expect(validAiKey("sk-or-v1-something")).toBe(false);
  });
});

describe("AI gateway pricing", () => {
  it("bills the upstream cost plus the platform markup", () => {
    expect(retailCost(0.01, 0.08)).toBeCloseTo(0.0108, 8);
    expect(round6(1.2345678)).toBe(1.234568);
  });

  it("pre-authorizes conservatively", () => {
    expect(reserveUsd(100, 100, 0.000001, 0.000002, 0.08, 1.15)).toBeCloseTo(0.0003726, 8);
  });

  it("falls back to token pricing when no generation cost is available", () => {
    expect(
      costFromUsage({ prompt_tokens: 100, completion_tokens: 50 }, 0.000001, 0.000002),
    ).toBeCloseTo(0.0002, 8);
  });

  it("estimates prompt tokens from the message payload", () => {
    expect(estimatePromptTokens([{ role: "user", content: "hello" }])).toBeGreaterThan(0);
  });
});
