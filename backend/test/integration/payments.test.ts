import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createTestClient, createWalletClient, http, publicActions, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../../src/config.js";
import { robinhoodChain } from "../../src/chain/client.js";
import { buildServer } from "../../src/api/server.js";
import { erc20Abi } from "../../src/chain/abis/index.js";
import { db } from "../../src/db/pool.js";
import { bullConnection, redis } from "../../src/redis.js";
import { closeQueues, QUEUE, queue } from "../../src/queues.js";
import { syncSupplierCatalog } from "../../src/modules/catalog/service.js";
import { fulfill, NUDGE_JOB, nudgeFulfillment, onFulfillmentJobFailed, processFulfillmentJob } from "../../src/modules/fulfillment/service.js";
import { createOrder } from "../../src/modules/orders/service.js";
import { watchPayments } from "../../src/modules/payments/watcher.js";
import { processRefund } from "../../src/modules/refunds/service.js";
import { createMockEsimAdapter } from "../../src/suppliers/mock.js";
import { adapter } from "../../src/suppliers/registry.js";
import { webhookToken } from "../../src/suppliers/webhooks.js";
import { TEST_USDC_BYTECODE } from "../contracts/testUsdc.js";

const USDC = config.USDC_ADDRESS as Address;
const deployer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"); // also refund wallet
const payer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

const transport = http(config.CHAIN_RPC_URL);
const anvil = createTestClient({ mode: "anvil", chain: robinhoodChain, transport }).extend(publicActions);
const payerWallet = createWalletClient({ account: payer, chain: robinhoodChain, transport });
const deployerWallet = createWalletClient({ account: deployer, chain: robinhoodChain, transport });

const mintAbi = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
] as const;

const usdcBalance = (a: Address) => anvil.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] });

async function pay(to: Address, amount: bigint) {
  const hash = await payerWallet.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [to, amount] });
  await anvil.waitForTransactionReceipt({ hash });
  await anvil.mine({ blocks: config.PAYMENT_CONFIRMATIONS });
}

let productId: string;

async function newOrder(payAsset: "USDC" | "ETH" = "USDC") {
  const { orderId, invoice } = await createOrder({ productId, fields: {}, payAsset });
  return { orderId, payTo: invoice.pay_to as Address, amount: BigInt(invoice.amount) };
}

const orderStatus = async (id: string) => (await db.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [id])).rows[0]!.status;
const invoiceStatus = async (id: string) =>
  (await db.query<{ status: string }>("SELECT status FROM invoices WHERE order_id = $1", [id])).rows[0]!.status;

beforeAll(async () => {
  // fresh schema
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = path.resolve("migrations");
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    await db.query(await readFile(path.join(dir, f), "utf8"));
  }
  await redis.flushdb();

  const hash = await deployerWallet.deployContract({ abi: mintAbi, bytecode: TEST_USDC_BYTECODE });
  const receipt = await anvil.waitForTransactionReceipt({ hash });
  expect(receipt.contractAddress?.toLowerCase()).toBe(USDC.toLowerCase());
  for (const to of [payer.address, deployer.address]) {
    await deployerWallet.writeContract({ address: USDC, abi: mintAbi, functionName: "mint", args: [to, 1_000_000_000n] });
  }

  const mock = createMockEsimAdapter();
  await syncSupplierCatalog(mock, await mock.syncCatalog());
  productId = (await db.query<{ id: string }>("SELECT id FROM products WHERE supplier_id = 'mock-esim' LIMIT 1")).rows[0]!.id;
});

afterAll(async () => {
  await closeQueues();
  await db.end();
  redis.disconnect();
});

describe("catalog sync", () => {
  it("ignores a SKU the supplier lists twice instead of failing the whole batch", async () => {
    const mock = createMockEsimAdapter();
    const listed = await mock.syncCatalog();
    const n = await syncSupplierCatalog(mock, [...listed, { ...listed[0]!, title: "duplicate listing" }]);
    expect(n).toBe(listed.length);
    const { rows } = await db.query("SELECT title FROM products WHERE supplier_id = 'mock-esim' AND supplier_sku = $1", [listed[0]!.supplierSku]);
    expect(rows).toEqual([{ title: listed[0]!.title }]);
  });
});

describe("payment watcher on a real chain", () => {
  it("exact payment → paid → fulfilled", async () => {
    const o = await newOrder();
    await pay(o.payTo, o.amount);
    await watchPayments();
    expect(await orderStatus(o.orderId)).toBe("paid");
    const inv = (await db.query("SELECT payer_address, received FROM invoices WHERE order_id = $1", [o.orderId])).rows[0];
    expect(inv.payer_address).toBe(payer.address.toLowerCase());
    expect(BigInt(inv.received)).toBe(o.amount);

    await fulfill(o.orderId);
    expect(await orderStatus(o.orderId)).toBe("delivered");
  });

  it("does not confirm before enough confirmations", async () => {
    const o = await newOrder();
    const hash = await payerWallet.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [o.payTo, o.amount] });
    await anvil.waitForTransactionReceipt({ hash });
    await watchPayments();
    expect(await invoiceStatus(o.orderId)).toBe("seen");
    expect(await orderStatus(o.orderId)).toBe("awaiting_payment");
    await anvil.mine({ blocks: config.PAYMENT_CONFIRMATIONS });
    await watchPayments();
    expect(await orderStatus(o.orderId)).toBe("paid");
  });

  it("overpayment → order paid + excess refunded exactly once", async () => {
    const o = await newOrder();
    const excess = 5_000_000n; // 5 USDC
    await pay(o.payTo, o.amount + excess);
    await watchPayments();
    expect(await orderStatus(o.orderId)).toBe("paid");

    const before = await usdcBalance(payer.address);
    await processRefund(o.orderId, "overpayment");
    await processRefund(o.orderId, "overpayment"); // retried job must not send again
    expect((await usdcBalance(payer.address)) - before).toBe(excess);
    const { rows } = await db.query("SELECT status, amount FROM refunds WHERE order_id = $1 AND kind = 'overpayment'", [o.orderId]);
    expect(rows[0]).toMatchObject({ status: "confirmed", amount: excess.toString() });
  });

  it("dust overpayment is not refunded", async () => {
    const o = await newOrder();
    await pay(o.payTo, o.amount + 100_000n); // 0.10 USDC < 0.50 minimum
    await watchPayments();
    expect(await orderStatus(o.orderId)).toBe("paid");
    const { rowCount } = await db.query("SELECT 1 FROM refunds WHERE order_id = $1", [o.orderId]);
    expect(rowCount).toBe(0);
  });

  it("unpaid invoice expires", async () => {
    const o = await newOrder();
    await db.query("UPDATE invoices SET expires_at = now() - interval '10 minutes' WHERE order_id = $1", [o.orderId]);
    await watchPayments();
    expect(await invoiceStatus(o.orderId)).toBe("expired");
    expect(await orderStatus(o.orderId)).toBe("expired");
  });

  it("payment after expiry → full refund, order refunded", async () => {
    const o = await newOrder();
    await db.query("UPDATE invoices SET expires_at = now() - interval '10 minutes' WHERE order_id = $1", [o.orderId]);
    await watchPayments(); // expires
    await pay(o.payTo, o.amount);
    await watchPayments();
    expect(await invoiceStatus(o.orderId)).toBe("late_paid");
    expect(await orderStatus(o.orderId)).toBe("refunding");

    const before = await usdcBalance(payer.address);
    await processRefund(o.orderId);
    expect((await usdcBalance(payer.address)) - before).toBe(o.amount);
    expect(await orderStatus(o.orderId)).toBe("refunded");
  });

  it("payment landing on a pending invoice after the deadline is treated as late", async () => {
    const o = await newOrder();
    await db.query("UPDATE invoices SET expires_at = now() - interval '10 minutes' WHERE order_id = $1", [o.orderId]);
    await pay(o.payTo, o.amount); // never seen before expiry
    await watchPayments();
    expect(await invoiceStatus(o.orderId)).toBe("late_paid");
    expect(await orderStatus(o.orderId)).toBe("refunding");
  });

  it("underpayment is held, then refunded after the grace period", async () => {
    const o = await newOrder();
    const partial = o.amount / 2n;
    await pay(o.payTo, partial);
    await watchPayments();
    expect(await invoiceStatus(o.orderId)).toBe("underpaid");

    // still within grace after expiry: held for a top-up
    await db.query("UPDATE invoices SET expires_at = now() - interval '1 hour' WHERE order_id = $1", [o.orderId]);
    await watchPayments();
    expect(await invoiceStatus(o.orderId)).toBe("underpaid");

    await db.query("UPDATE invoices SET expires_at = now() - interval '25 hours' WHERE order_id = $1", [o.orderId]);
    await watchPayments();
    expect(await invoiceStatus(o.orderId)).toBe("late_paid");

    const before = await usdcBalance(payer.address);
    await processRefund(o.orderId);
    expect((await usdcBalance(payer.address)) - before).toBe(partial);
    expect(await orderStatus(o.orderId)).toBe("refunded");
  });

  it("underpayment topped up in time → paid", async () => {
    const o = await newOrder();
    await pay(o.payTo, o.amount - 1_000_000n);
    await watchPayments();
    expect(await invoiceStatus(o.orderId)).toBe("underpaid");
    await pay(o.payTo, 1_000_000n);
    await watchPayments();
    expect(await orderStatus(o.orderId)).toBe("paid");
  });

  describe("native ETH", () => {
    beforeAll(async () => {
      await redis.set("price:ETH", "3000");
    });

    it("finds the payer by binary search and refunds an ETH overpayment", async () => {
      await anvil.mine({ blocks: 50 }); // put the invoice start well inside a longer chain
      const o = await newOrder("ETH");
      await anvil.mine({ blocks: 37 });
      const excess = 10n ** 16n; // 0.01 ETH ≈ $30
      const hash = await payerWallet.sendTransaction({ to: o.payTo, value: o.amount + excess });
      await anvil.waitForTransactionReceipt({ hash });
      await anvil.mine({ blocks: 20 });

      await watchPayments();
      expect(await orderStatus(o.orderId)).toBe("paid");
      const inv = (await db.query("SELECT payer_address, tx_hash FROM invoices WHERE order_id = $1", [o.orderId])).rows[0];
      expect(inv).toMatchObject({ payer_address: payer.address.toLowerCase(), tx_hash: hash });

      const before = await anvil.getBalance({ address: payer.address });
      await processRefund(o.orderId, "overpayment");
      expect((await anvil.getBalance({ address: payer.address })) - before).toBe(excess);
    });

    it("ETH checkout is disabled without a fresh price", async () => {
      await redis.del("price:ETH");
      await expect(newOrder("ETH")).rejects.toThrow(/temporarily unavailable/);
      await redis.set("price:ETH", "3000");
    });
  });
});

describe("supplier webhooks", () => {
  const ORDER_ID = "7f1c2e0a-1111-4222-8333-944455556666";
  const app = buildServer();
  const hook = (token: string, query = "") => app.inject({ method: "POST", url: `/webhooks/suppliers/mock-esim/${token}${query}`, payload: {} });
  const nudgeJob = (orderId: string) => queue(QUEUE.fulfillment).getJob(`nudge-${orderId}`);

  afterAll(() => app.close());

  it("re-checks an order that is still being fulfilled, and only that", async () => {
    const o = await newOrder();
    await pay(o.payTo, o.amount);
    await watchPayments();
    const token = webhookToken("mock-esim");

    expect((await hook("0".repeat(64), `?order=${o.orderId}`)).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/webhooks/suppliers/nope/${token}` })).statusCode).toBe(404);

    // paid but not yet handed to the supplier: nothing to re-check
    expect((await hook(token, `?order=${o.orderId}`)).statusCode).toBe(200);
    expect(await nudgeJob(o.orderId)).toBeUndefined();

    await db.query("UPDATE orders SET status = 'fulfilling' WHERE id = $1", [o.orderId]);
    await db.query("INSERT INTO fulfillments (order_id, supplier_id, idempotency_key, supplier_order_id) VALUES ($1, 'mock-esim', $2, 'sup-1')", [o.orderId, o.orderId]);
    expect(await nudgeFulfillment("mock-esim", { supplierOrderId: "other" })).toBe(false);
    expect(await nudgeFulfillment("bitrefill", { supplierOrderId: "sup-1" })).toBe(false);

    // a form-encoded body is accepted and ignored
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/suppliers/mock-esim/${token}?order=${o.orderId}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "status=complete",
    });
    expect(res.statusCode).toBe(200);
    const job = await nudgeJob(o.orderId);
    expect(job).toMatchObject({ name: NUDGE_JOB, data: { orderId: o.orderId }, opts: { attempts: 1 } });
    expect(await nudgeFulfillment("mock-esim", { supplierOrderId: "sup-1" })).toBe(true); // same job, not a second one
    await job!.remove();

    await db.query("UPDATE orders SET status = 'delivered' WHERE id = $1", [o.orderId]);
    expect(await nudgeFulfillment("mock-esim", { orderId: o.orderId })).toBe(false);
  });

  it("keeps the URL secret out of the request log", async () => {
    const lines: string[] = [];
    const level = config.LOG_LEVEL;
    config.LOG_LEVEL = "info";
    const logged = buildServer({ write: (line) => lines.push(line) });
    config.LOG_LEVEL = level;
    const token = webhookToken("mock-esim");
    const res = await logged.inject({ method: "POST", url: `/webhooks/suppliers/mock-esim/${token}?order=${ORDER_ID}`, payload: {} });
    await logged.close();
    expect(res.statusCode).toBe(200);
    const log = lines.join("");
    expect(log).toContain(`/webhooks/suppliers/mock-esim/[redacted]?order=${ORDER_ID}`);
    expect(log).not.toContain(token);
  });

  it("a failing nudge leaves the order alone; only the order's own last attempt fails and refunds it", async () => {
    const o = await newOrder();
    await pay(o.payTo, o.amount);
    await watchPayments();
    // already placed at the supplier, which now reports the order as failed
    await db.query("UPDATE orders SET status = 'fulfilling' WHERE id = $1", [o.orderId]);
    await db.query("INSERT INTO fulfillments (order_id, supplier_id, idempotency_key, supplier_order_id) VALUES ($1, 'mock-esim', $2, 'gone')", [o.orderId, o.orderId]);
    const fulfillmentStatus = async () => (await db.query("SELECT status FROM fulfillments WHERE order_id = $1", [o.orderId])).rows[0].status;

    // the real processor and failed-job handler of the workers process, on a clean queue
    await queue(QUEUE.fulfillment).obliterate({ force: true });
    const handled: { name: string; err: string }[] = [];
    let wake = () => {};
    const worker = new Worker<{ orderId: string }>(QUEUE.fulfillment, (job) => fulfill(job.data.orderId), { connection: bullConnection() });
    worker.on("failed", async (job, err) => {
      await onFulfillmentJobFailed(job, err);
      handled.push({ name: job!.name, err: err.message });
      wake();
    });
    const nextFailure = () => new Promise<void>((resolve) => (wake = resolve));

    try {
      let failure = nextFailure();
      expect(await nudgeFulfillment("mock-esim", { supplierOrderId: "gone" })).toBe(true);
      await failure;
      expect(handled).toEqual([{ name: NUDGE_JOB, err: "supplier order gone failed" }]);
      expect(await orderStatus(o.orderId)).toBe("fulfilling");
      expect(await fulfillmentStatus()).toBe("pending");
      expect(await nudgeJob(o.orderId)).toBeUndefined(); // gone, so the next notification can queue again

      failure = nextFailure();
      await queue(QUEUE.fulfillment).add("fulfill", { orderId: o.orderId }, { jobId: `fulfill-${o.orderId}`, attempts: 1 });
      await failure;
      expect(handled[1]).toEqual({ name: "fulfill", err: "supplier order gone failed" });
      expect(await fulfillmentStatus()).toBe("failed");
      expect(await orderStatus(o.orderId)).toBe("refunding");
    } finally {
      await worker.close();
    }
  });
});

describe("supplier still working", () => {
  const until = async (ok: () => Promise<boolean>) => {
    for (let i = 0; i < 200; i++) {
      if (await ok()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("timed out waiting");
  };

  it("waits without using up attempts, alerts a human after the limit, never refunds, and still delivers late", async () => {
    const alerts: { kind: string; message: string; details: Record<string, unknown> }[] = [];
    const sink = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        alerts.push(JSON.parse(body));
        res.end();
      });
    });
    await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
    config.ALERT_WEBHOOK_URL = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/hook`;

    await queue(QUEUE.fulfillment).obliterate({ force: true });
    const o = await newOrder();
    await pay(o.payTo, o.amount);
    await watchPayments(); // queues the order's own job: 5 attempts
    const job = async () => (await queue(QUEUE.fulfillment).getJob(`fulfill-${o.orderId}`))!;
    expect((await job()).opts.attempts).toBe(5);

    const status = vi.spyOn(adapter("mock-esim"), "status").mockResolvedValue("pending");
    const failures: string[] = [];
    // the processor and failed-job handler of the workers process
    const worker = new Worker<{ orderId: string }>(QUEUE.fulfillment, processFulfillmentJob, { connection: bullConnection() });
    worker.on("failed", async (j, err) => {
      failures.push(err.message);
      await onFulfillmentJobFailed(j, err);
    });
    const waiting = (checks: number) => until(async () => status.mock.calls.length === checks && (await (await job()).getState()) === "delayed");

    try {
      // more pending answers than the job has attempts
      for (let check = 1; check <= 8; check++) {
        await waiting(check);
        if (check < 8) await (await job()).promote();
      }
      expect(await orderStatus(o.orderId)).toBe("fulfilling");
      expect(failures).toEqual([]);
      expect(alerts).toEqual([]);
      let j = await job();
      expect(j.attemptsMade).toBe(0);
      expect(j.delay).toBeGreaterThan(25_000);
      expect(j.delay).toBeLessThanOrEqual(30_000);

      // an hour later: a human is alerted, the order is neither failed nor refunded
      await db.query("UPDATE fulfillments SET created_at = now() - interval '61 minutes' WHERE order_id = $1", [o.orderId]);
      await j.promote();
      await waiting(9);
      await until(async () => alerts.length === 1);
      expect(alerts[0]).toMatchObject({
        kind: "action",
        message: expect.stringContaining("supplier order still pending"),
        details: { orderId: o.orderId, supplier: "mock-esim", supplierOrderId: `mock_${o.orderId}`, pending_minutes: 61 },
      });
      expect(await orderStatus(o.orderId)).toBe("fulfilling");
      expect((await db.query("SELECT 1 FROM refunds WHERE order_id = $1", [o.orderId])).rowCount).toBe(0);
      j = await job();
      expect(j.delay).toBeGreaterThan(9 * 60_000); // slower re-checks from here on
      await j.promote();
      await waiting(10);
      expect(alerts).toHaveLength(1); // reminder is on a cooldown, not every re-check

      // the supplier delivers after all
      status.mockRestore();
      await (await job()).promote();
      await until(async () => (await orderStatus(o.orderId)) === "delivered");
      expect(failures).toEqual([]);
    } finally {
      status.mockRestore();
      await worker.close();
      config.ALERT_WEBHOOK_URL = undefined;
      sink.close();
    }
  });
});
