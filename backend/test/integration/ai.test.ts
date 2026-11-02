import { readdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { db } from "../../src/db/pool.js";
import { decryptAiKey } from "../../src/modules/ai/keys.js";
import { issueKey, revokeKey } from "../../src/modules/ai/service.js";
import { fulfill } from "../../src/modules/fulfillment/service.js";
import { createOrder } from "../../src/modules/orders/service.js";
import { syncSupplierCatalog } from "../../src/modules/catalog/service.js";
import { redis } from "../../src/redis.js";
import { adapter } from "../../src/suppliers/registry.js";

const MODEL = "test/model";
const GEN = "gen-test-1";

let fake: Server;
let app: FastifyInstance;
let appBase: string;
let orderId: string;
let keyId: string;
let apiKey: string;
let credit: number;

const until = async (ok: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting");
};

const auth = () => ({ authorization: `Bearer ${apiKey}` });

beforeAll(async () => {
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = path.resolve("migrations");
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    await db.query(await readFile(path.join(dir, f), "utf8"));
  }
  await redis.flushdb();

  fake = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1:59999");
    if (url.pathname === "/models") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            {
              id: MODEL,
              name: "Test Model",
              context_length: 4096,
              pricing: { prompt: "0.000001", completion: "0.000002" },
            },
          ],
        }),
      );
      return;
    }
    if (url.pathname === "/credits") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: { total_credits: 100, total_usage: 0 } }));
      return;
    }
    if (url.pathname === "/generation") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: { total_cost: 0.01 } }));
      return;
    }
    if (url.pathname === "/chat/completions" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as { stream?: boolean };
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          res.write(`data: {"id":"gen-stream-1","choices":[{"delta":{"content":"hi"}}]}\n\n`);
          res.write(`data: {"id":"gen-stream-1","usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              id: GEN,
              object: "chat.completion",
              choices: [{ index: 0, message: { role: "assistant", content: "hello" } }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            }),
          );
        }
      });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => fake.listen(59999, "127.0.0.1", resolve));

  const nomaAi = adapter("noma-ai");
  await syncSupplierCatalog(nomaAi, await nomaAi.syncCatalog());
  const product = (
    await db.query<{ id: string; price_usd: string }>(
      "SELECT id, price_usd FROM products WHERE supplier_id = 'noma-ai' ORDER BY price_usd ASC LIMIT 1",
    )
  ).rows[0]!;
  credit = Number(product.price_usd);

  const created = await createOrder({ productId: product.id, fields: {}, payAsset: "USDG" });
  orderId = created.orderId;
  await db.query("UPDATE orders SET status = 'paid' WHERE id = $1", [orderId]);
  await fulfill(orderId);

  const keyRow = (
    await db.query<{ id: string; key_encrypted: string; credit_usd: string }>(
      "SELECT id, key_encrypted, credit_usd FROM ai_keys WHERE order_id = $1",
      [orderId],
    )
  ).rows[0]!;
  keyId = keyRow.id;
  apiKey = decryptAiKey(keyRow.key_encrypted);
  expect(Number(keyRow.credit_usd)).toBeCloseTo(credit, 6);

  app = buildServer();
  appBase = await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => {
    fake.close(() => resolve());
    fake.closeAllConnections?.();
  });
  await db.end();
  redis.disconnect();
});

describe("AI gateway key issuance", () => {
  it("issues one NOMA key per order and never exposes an OpenRouter key", async () => {
    const again = await issueKey(orderId);
    expect(again.keyId).toBe(keyId);
    const count = (await db.query("SELECT count(*)::int AS n FROM ai_keys WHERE order_id = $1", [orderId])).rows[0].n;
    expect(count).toBe(1);
    expect(apiKey.startsWith("noma_sk_")).toBe(true);
    expect(again.payload.base_url).toBe("http://localhost:3101/api/ai/v1");
    expect(again.payload.models).toEqual([MODEL]);
    expect(await adapter("noma-ai").balance()).toBe(100);
  });
});

describe("AI gateway chat", () => {
  it("charges the actual upstream cost plus markup and updates the balance", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/ai/v1/chat/completions",
      headers: auth(),
      payload: { model: MODEL, messages: [{ role: "user", content: "hello" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(GEN);

    const usage = (
      await db.query("SELECT status, openrouter_cost_usd, retail_cost_usd FROM ai_usage WHERE order_id = $1", [orderId])
    ).rows[0];
    expect(usage.status).toBe("settled");
    expect(Number(usage.openrouter_cost_usd)).toBeCloseTo(0.01, 8);
    expect(Number(usage.retail_cost_usd)).toBeCloseTo(0.0108, 8);

    const balance = await app.inject({ method: "GET", url: "/ai/v1/usage", headers: auth() });
    expect(balance.statusCode).toBe(200);
    expect(balance.json().remaining_usd).toBeCloseTo(credit - 0.0108, 4);
  });

  it("streams the upstream SSE and settles after the stream", async () => {
    const res = await fetch(`${appBase}/ai/v1/chat/completions`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("hi");
    await until(async () => {
      const row = (
        await db.query("SELECT status FROM ai_usage WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1", [orderId])
      ).rows[0];
      return row?.status === "settled";
    });
    const used = (await db.query("SELECT used_usd FROM ai_keys WHERE id = $1", [keyId])).rows[0].used_usd;
    expect(Number(used)).toBeCloseTo(0.0216, 4);
  });

  it("lists the allowlist and rejects unknown models", async () => {
    const models = await app.inject({ method: "GET", url: "/ai/v1/models", headers: auth() });
    expect(models.statusCode).toBe(200);
    expect(models.json().data[0].id).toBe(MODEL);

    const wrong = await app.inject({
      method: "POST",
      url: "/ai/v1/chat/completions",
      headers: auth(),
      payload: { model: "not/allowed", messages: [{ role: "user", content: "x" }] },
    });
    expect(wrong.statusCode).toBe(400);
  });

  it("rejects invalid, expired, revoked, and unaffordable keys", async () => {
    const invalid = await app.inject({
      method: "POST",
      url: "/ai/v1/chat/completions",
      headers: { authorization: "Bearer noma_sk_invalid" },
      payload: { model: MODEL, messages: [{ role: "user", content: "x" }] },
    });
    expect(invalid.statusCode).toBe(401);

    await db.query("UPDATE ai_keys SET expires_at = now() - interval '1 day' WHERE id = $1", [keyId]);
    const expired = await app.inject({ method: "GET", url: "/ai/v1/usage", headers: auth() });
    expect(expired.statusCode).toBe(401);
    await db.query("UPDATE ai_keys SET expires_at = now() + interval '1 year' WHERE id = $1", [keyId]);

    await db.query("UPDATE ai_keys SET used_usd = credit_usd WHERE id = $1", [keyId]);
    const poor = await app.inject({
      method: "POST",
      url: "/ai/v1/chat/completions",
      headers: auth(),
      payload: { model: MODEL, messages: [{ role: "user", content: "x" }] },
    });
    expect(poor.statusCode).toBe(402);
    await db.query("UPDATE ai_keys SET used_usd = 0.0216 WHERE id = $1", [keyId]);

    await revokeKey(keyId);
    const revoked = await app.inject({ method: "GET", url: "/ai/v1/usage", headers: auth() });
    expect(revoked.statusCode).toBe(401);
  });
});
