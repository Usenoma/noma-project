import { readdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
  process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
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
  const { syncSupplierCatalog } = await import("../../src/modules/catalog/service.js");
  const { createMockEsimAdapter } = await import("../../src/suppliers/mock.js");
  const mock = createMockEsimAdapter();
  await syncSupplierCatalog(mock, await mock.syncCatalog());
});

afterAll(async () => {
  server.close();
  await mod?.closeQueues();
  await mod?.db.end();
  mod?.redis.disconnect();
});

async function fulfillment(status: "done" | "failed") {
  const productId = (await mod.db.query<{ id: string }>("SELECT id FROM products LIMIT 1")).rows[0]!.id;
  const { orderId } = await mod.createOrder({ productId, fields: {}, payAsset: "USDC" });
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
    expect(received.filter((a) => !a.message.includes("RPC"))).toEqual([]);
  });

  it("alerts on a high fulfillment failure rate, with the failing supplier", async () => {
    await fulfillment("failed");
    await fulfillment("failed");
    await mod.checkHealth();
    const a = received.find((r) => r.message === "fulfillment failure rate high");
    expect(a?.details).toMatchObject({ failed: 3, done: 1, by_supplier: { "mock-esim": 3 } });
  });
});
