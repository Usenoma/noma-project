import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { mnemonicToSeedSync } from "@scure/bip39";
import { createTestClient, createWalletClient, http, parseEther, publicActions, type Address } from "viem";
import { generatePrivateKey, HDKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { erc20Abi } from "../../src/chain/abis/index.js";
import { TEST_USDC_BYTECODE } from "../contracts/testUsdc.js";

// Same node as PAYMENT_XPUB in vitest.integration.config.ts (anvil dev mnemonic, account 1').
const MNEMONIC = "test test test test test test test test test test test junk";
const XPRV = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive("m/44'/60'/1'/0").privateExtendedKey;

// fresh keys (every anvil dev account is used by another test file and its nonces matter there)
const payer = privateKeyToAccount(generatePrivateKey());
const gasFunderKey = generatePrivateKey();
const gasFunder = privateKeyToAccount(gasFunderKey);
const TREASURY = privateKeyToAccount(generatePrivateKey()).address;

const chainDef = {
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:58545"] } },
} as const;
const transport = http("http://127.0.0.1:58545");
const anvil = createTestClient({ mode: "anvil", chain: chainDef, transport }).extend(publicActions);
const payerWallet = createWalletClient({ account: payer, chain: chainDef, transport });
const mintAbi = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
] as const;

let USDC: Address;
let mod: typeof import("../../src/sweeper/service.js") &
  typeof import("../../src/db/pool.js") &
  typeof import("../../src/redis.js") &
  typeof import("../../src/modules/orders/service.js") &
  typeof import("../../src/modules/payments/watcher.js") &
  typeof import("../../src/queues.js");

async function paidOrder(asset: "USDC" | "ETH", extra = 0n) {
  const productId = (await mod.db.query<{ id: string }>("SELECT id FROM products WHERE supplier_id = 'mock-esim' LIMIT 1")).rows[0]!.id;
  const { orderId, invoice } = await mod.createOrder({ productId, fields: {}, payAsset: asset });
  const to = invoice.pay_to as Address;
  const amount = BigInt(invoice.amount) + extra;
  const hash =
    asset === "ETH"
      ? await payerWallet.sendTransaction({ to, value: amount })
      : await payerWallet.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [to, amount] });
  await anvil.waitForTransactionReceipt({ hash });
  await anvil.mine({ blocks: 3 });
  await mod.watchPayments();
  const inv = (await mod.db.query("SELECT id, status FROM invoices WHERE order_id = $1", [orderId])).rows[0];
  expect(inv.status).toBe("confirmed");
  return { orderId, invoiceId: inv.id as string, payTo: to, amount };
}

const usdc = (a: Address) => anvil.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] });

beforeAll(async () => {
  await anvil.setBalance({ address: payer.address, value: parseEther("100") });
  await anvil.setBalance({ address: gasFunder.address, value: parseEther("10") });
  const deploy = await payerWallet.deployContract({ abi: mintAbi, bytecode: TEST_USDC_BYTECODE });
  USDC = (await anvil.waitForTransactionReceipt({ hash: deploy })).contractAddress!;
  await anvil.waitForTransactionReceipt({
    hash: await payerWallet.writeContract({ address: USDC, abi: mintAbi, functionName: "mint", args: [payer.address, 1_000_000_000n] }),
  });

  Object.assign(process.env, {
    USDC_ADDRESS: USDC,
    PAYMENT_XPRV: XPRV,
    TREASURY_ADDRESS: TREASURY,
    SWEEPER_GAS_PRIVATE_KEY: gasFunderKey,
    SWEEP_MIN_USD: "1",
  });
  mod = {
    ...(await import("../../src/sweeper/service.js")),
    ...(await import("../../src/db/pool.js")),
    ...(await import("../../src/redis.js")),
    ...(await import("../../src/modules/orders/service.js")),
    ...(await import("../../src/modules/payments/watcher.js")),
    ...(await import("../../src/queues.js")),
  } as typeof mod;
  const { syncSupplierCatalog } = await import("../../src/modules/catalog/service.js");
  const { createMockEsimAdapter } = await import("../../src/suppliers/mock.js");

  await mod.db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = path.resolve("migrations");
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    await mod.db.query(await readFile(path.join(dir, f), "utf8"));
  }
  await mod.redis.flushdb();
  await mod.redis.set("price:ETH", "3000");
  const mock = createMockEsimAdapter();
  await syncSupplierCatalog(mock, await mock.syncCatalog());
});

afterAll(async () => {
  await mod?.closeQueues();
  await mod?.db.end();
  mod?.redis.disconnect();
});

describe("deposit sweeper", () => {
  it("refuses an xprv that does not match PAYMENT_XPUB", async () => {
    const other = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive("m/44'/60'/2'/0").privateExtendedKey;
    const { config } = await import("../../src/config.js");
    const saved = config.PAYMENT_XPRV;
    config.PAYMENT_XPRV = other;
    expect(() => mod.assertSweeperConfig()).toThrow(/does not match/);
    config.PAYMENT_XPRV = saved;
  });

  it("does not touch an invoice the watcher still reads", async () => {
    const productId = (await mod.db.query<{ id: string }>("SELECT id FROM products LIMIT 1")).rows[0]!.id;
    const { invoice } = await mod.createOrder({ productId, fields: {}, payAsset: "USDC" });
    await payerWallet.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [invoice.pay_to as Address, BigInt(invoice.amount) / 2n] });
    await anvil.mine({ blocks: 3 });
    await mod.watchPayments(); // underpaid: still watched
    expect(await mod.sweepDeposits()).toBe(0);
    expect(await usdc(invoice.pay_to as Address)).toBe(BigInt(invoice.amount) / 2n);
  });

  it("sweeps a paid ETH invoice to the treasury, leaving only gas headroom", async () => {
    const o = await paidOrder("ETH");
    expect(await mod.sweepDeposits()).toBe(1);
    const got = await anvil.getBalance({ address: TREASURY });
    const left = await anvil.getBalance({ address: o.payTo });
    expect(got + left).toBeLessThan(o.amount); // gas was paid
    expect(o.amount - got).toBeLessThan(parseEther("0.0001")); // at most the gas budget stays behind
    const row = (await mod.db.query("SELECT status, amount, round, tx_hash FROM sweeps WHERE invoice_id = $1", [o.invoiceId])).rows[0];
    expect(row).toMatchObject({ status: "swept", amount: got.toString(), round: 1 });
    // swept addresses are not re-checked
    expect(await mod.sweepDeposits()).toBe(0);
  });

  it("sweeps a paid USDC invoice: gas top-up from the gas wallet, full token balance to the treasury", async () => {
    const o = await paidOrder("USDC", 2_000_000n);
    const funderBefore = await anvil.getBalance({ address: gasFunder.address });
    expect(await mod.sweepDeposits()).toBe(1);
    expect(await usdc(TREASURY)).toBe(o.amount);
    expect(await usdc(o.payTo)).toBe(0n);
    const row = (await mod.db.query("SELECT amount, gas_topup FROM sweeps WHERE invoice_id = $1", [o.invoiceId])).rows[0];
    expect(row.amount).toBe(o.amount.toString());
    expect(BigInt(row.gas_topup)).toBeGreaterThan(0n);
    expect(funderBefore - (await anvil.getBalance({ address: gasFunder.address }))).toBeGreaterThanOrEqual(BigInt(row.gas_topup));
  });

  it("a crash after the transfer landed but before the DB update does not send twice", async () => {
    const o = await paidOrder("ETH");
    expect(await mod.sweepDeposits()).toBe(1);
    const first = (await mod.db.query("SELECT tx_hash FROM sweeps WHERE invoice_id = $1", [o.invoiceId])).rows[0].tx_hash;
    const treasuryAfter = await anvil.getBalance({ address: TREASURY });
    // as if the process died right after the receipt: the round is still pending
    await mod.db.query("UPDATE sweeps SET status = 'pending', tx_hash = NULL, amount = NULL WHERE invoice_id = $1", [o.invoiceId]);
    await mod.redis.set("price:ETH", "3000");

    expect(await mod.sweepDeposits()).toBe(1);
    const rows = (await mod.db.query("SELECT round, status, tx_hash FROM sweeps WHERE invoice_id = $1", [o.invoiceId])).rows;
    expect(rows).toEqual([{ round: 1, status: "swept", tx_hash: first }]);
    expect(await anvil.getBalance({ address: TREASURY })).toBe(treasuryAfter);
  });
});
