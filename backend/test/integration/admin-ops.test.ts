import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { config } from "../../src/config.js";
import { db } from "../../src/db/pool.js";
import { closeQueues } from "../../src/queues.js";
import { redis } from "../../src/redis.js";

let app: FastifyInstance;
let orderId: string;
let claimId: string;
const auth = () => ({ authorization: `Bearer ${config.ADMIN_TOKEN}` });

beforeAll(async () => {
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = path.resolve("migrations");
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    await db.query(await readFile(path.join(dir, f), "utf8"));
  }
  await redis.flushdb();

  await db.query("INSERT INTO suppliers (id, name, category) VALUES ('ops-test', 'Ops Test', 'esim')");
  const product = (
    await db.query<{ id: string }>(
      `INSERT INTO products (supplier_id, supplier_sku, category, title, cost_usd, price_usd, required_fields)
       VALUES ('ops-test', 'ops-sku', 'esim', 'Ops test product', 1, 2, '[]') RETURNING id`,
    )
  ).rows[0]!;
  orderId = (
    await db.query<{ id: string }>(
      `INSERT INTO orders (product_id, order_key_hash, price_usd, status)
       VALUES ($1, 'ops-test-hash', 2, 'refunding') RETURNING id`,
      [product.id],
    )
  ).rows[0]!.id;
  await db.query(
    `INSERT INTO invoices (order_id, chain, asset, amount, pay_to, address_index, payment_ref, expires_at, status)
     VALUES ($1, 'robinhood', 'USDG', 1, '0x0000000000000000000000000000000000000001', 999999, $2, now(), 'underpaid')`,
    [orderId, `ops_${randomUUID()}`],
  );
  claimId = (
    await db.query<{ id: string }>(
      `INSERT INTO payment_claims (order_id, tx_hash, asset, amount, payer_address, status)
       VALUES ($1, $2, 'USDG', 1, '0x0000000000000000000000000000000000000002', 'open') RETURNING id`,
      [orderId, `0x${"ab".repeat(32)}`],
    )
  ).rows[0]!.id;
  await db.query(
    `INSERT INTO refunds (order_id, kind, amount, asset, to_address, status)
     VALUES ($1, 'full', 1, 'USDG', '0x0000000000000000000000000000000000000002', 'failed')`,
    [orderId],
  );

  app = buildServer();
});

afterAll(async () => {
  await app.close();
  await closeQueues();
  await db.end();
  redis.disconnect();
});

describe("admin ops endpoints", () => {
  it("requires the admin token", async () => {
    expect((await app.inject({ method: "GET", url: "/admin/payment-claims" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/admin/refunds" })).statusCode).toBe(401);
  });

  it("lists open claims and rejects one without touching the order", async () => {
    const list = await app.inject({ method: "GET", url: "/admin/payment-claims?status=open", headers: auth() });
    expect(list.statusCode).toBe(200);
    expect(list.json().claims.find((c: { id: string }) => c.id === claimId)).toMatchObject({
      order_id: orderId,
      asset: "USDG",
      amount: "1",
      status: "open",
    });

    const resolved = await app.inject({
      method: "POST",
      url: `/admin/payment-claims/${claimId}/resolve`,
      headers: auth(),
      payload: { action: "reject", note: "integration test" },
    });
    expect(resolved.statusCode).toBe(200);
    const claim = (await db.query("SELECT status FROM payment_claims WHERE id = $1", [claimId])).rows[0];
    expect(claim.status).toBe("rejected");
    const order = (await db.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0];
    expect(order.status).toBe("refunding");
  });

  it("lists failed refunds and re-queues one with a fresh pending state", async () => {
    const failed = await app.inject({ method: "GET", url: "/admin/refunds?status=failed", headers: auth() });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().refunds.some((r: { order_id: string }) => r.order_id === orderId)).toBe(true);

    const retried = await app.inject({
      method: "POST",
      url: `/admin/orders/${orderId}/refund/retry`,
      headers: auth(),
      payload: { kind: "full" },
    });
    expect(retried.statusCode).toBe(200);
    const row = (await db.query("SELECT status FROM refunds WHERE order_id = $1 AND kind = 'full'", [orderId])).rows[0];
    expect(row.status).toBe("pending");
  });

  it("sends a test alert and reports whether a delivery channel exists", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/alerts/test", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, delivery_configured: false });
  });
});
