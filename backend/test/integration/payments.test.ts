import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createTestClient, createWalletClient, http, publicActions, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { robinhoodChain } from "../../src/chain/client.js";
import { erc20Abi } from "../../src/chain/abis/index.js";
import { db } from "../../src/db/pool.js";
import { redis } from "../../src/redis.js";
import { closeQueues } from "../../src/queues.js";
import { syncSupplierCatalog } from "../../src/modules/catalog/service.js";
import { fulfill } from "../../src/modules/fulfillment/service.js";
import { createOrder } from "../../src/modules/orders/service.js";
import { watchPayments } from "../../src/modules/payments/watcher.js";
import { processRefund } from "../../src/modules/refunds/service.js";
import { createMockEsimAdapter } from "../../src/suppliers/mock.js";
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
