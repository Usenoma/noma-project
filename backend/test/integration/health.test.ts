import { readdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createTestClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const refundKey = generatePrivateKey(); // empty wallet: the low-balance alert must fire
const anvil = createTestClient({ mode: "anvil", transport: http("http://127.0.0.1:58545") });

const received: { message: string; details: Record<string, unknown> }[] = [];
let server: Server;
let mod: typeof import("../../src/modules/health/monitor.js") &
  typeof import("../../src/db/pool.js") &
  typeof import("../../src/redis.js") &
  typeof import("../../src/queues.js") &
  typeof import("../../src/modules/orders/service.js");

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    ALERT_WEBHOOK_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`,
    REFUND_PRIVATE_KEY: refundKey,
    USDC_ADDRESS: "", // ETH float only here; the USDC path reads the same way
  });
  mod = {
    ...(await import("../../src/modules/health/monitor.js")),
    ...(await import("../../src/db/pool.js")),
    ...(await import("../../src/redis.js")),
    ...(await import("../../src/queues.js")),
    ...(await import("../../src/modules/orders/service.js")),
  } as typeof mod;

  await mod.db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = path.resolve("migrations");
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    await mod.db.query(await readFile(path.join(dir, f), "utf8"));
  }
  await mod.redis.flushdb();
  await mod.redis.set("price:ETH", "3000");
  const { syncSupplierCatalog } = await import("../../src/modules/catalog/service.js");
  const { createMockEsimAdapter } = await import("../../src/suppliers/mock.js");
  const mock = createMockEsimAdapter();
  await syncSupplierCatalog(mock, await mock.syncCatalog());
  it("alerts when the refund hot wallet runs low, and stops once topped up", async () => {
    const wallet = privateKeyToAccount(refundKey).address;
    const low = received.find((r) => r.message.startsWith("refund hot wallet low"));
    expect(low?.details).toMatchObject({ wallet, eth: 0 });

    await anvil.setBalance({ address: wallet, value: 10n ** 18n });
    await mod.redis.del("alert:refund-wallet-low");
    const before = received.length;
    await mod.checkHealth();
    expect(received.slice(before).some((r) => r.message.startsWith("refund hot wallet low"))).toBe(false);
  });
});

afterAll(async () => {
  server.close();
  await mod?.closeQueues();
  await mod?.db.end();
  mod?.redis.disconnect();
});

async function fulfillment(status: "done" | "failed") {
  const productId = (await mod.db.query<{ id: string }>("SELECT id FROM products LIMIT 1")).rows[0]!.id;
  const { orderId } = await mod.createOrder({ productId, fields: {}, payAsset: "ETH" });
  await mod.db.query("INSERT INTO fulfillments (order_id, supplier_id, idempotency_key, status) VALUES ($1, 'mock-esim', $2, $3)", [
    orderId,
    orderId,
    status,
  ]);
}

describe("health monitor", () => {
  it("stays quiet while everything is healthy", async () => {
    await mod.markRun("payment-watcher");
    await mod.markRun("reward-indexer");
    await fulfillment("done");
    await fulfillment("failed");
    await mod.checkHealth();
    expect(received.filter((a) => /fulfillment|has not completed/.test(a.message))).toEqual([]);
  });

  it("alerts on a high fulfillment failure rate, with the failing supplier", async () => {
    await fulfillment("failed");
    await fulfillment("failed");
    await mod.checkHealth();
    const a = received.find((r) => r.message === "fulfillment failure rate high");
    expect(a?.details).toMatchObject({ failed: 3, done: 1, by_supplier: { "mock-esim": 3 } });
  });
});
