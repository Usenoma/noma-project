import { createServer, type Server } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseEther,
  publicActions,
  recoverAddress,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USDC_BYTECODE } from "../contracts/testUsdc.js";

/**
 * Reward cycle through a real Safe v1.4.1 (2-of-2 owners) on anvil. A local stand-in for the Safe
 * Transaction Service checks every proposal against Safe.getTransactionHash on-chain and the
 * delegate signature; the test then signs as the owners and executes it like Safe{Wallet} would.
 */

// well-known anvil dev keys (accounts 2, 5, 7, 8, 9); public test keys only
const admin = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const staker = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const deployer = privateKeyToAccount("0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356"); // also the Safe delegate/proposer
const owner1 = privateKeyToAccount("0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97");
const owner2 = privateKeyToAccount("0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6");

const RPC = "http://127.0.0.1:58545";
const SERVICE_PORT = 58600;
const WEEK = 7 * 24 * 3600;
const U = 1_000_000n;

const anvil = createTestClient({ mode: "anvil", chain: { id: 31337 } as never, transport: http(RPC) }).extend(publicActions);
const wallet = (account: PrivateKeyAccount) => createWalletClient({ account, chain: { id: 31337 } as never, transport: http(RPC) });

const artifact = async (file: string) =>
  JSON.parse(await readFile(path.resolve(file), "utf8")) as { abi: Abi; bytecode: Hex | { object: Hex } };
const bytecodeOf = (a: { bytecode: Hex | { object: Hex } }) => (typeof a.bytecode === "string" ? a.bytecode : a.bytecode.object);

async function deploy(file: string, args: unknown[] = []): Promise<{ address: Address; abi: Abi }> {
  const a = await artifact(file);
  const hash = await wallet(deployer).deployContract({ abi: a.abi, bytecode: bytecodeOf(a), args } as never);
  const r = await anvil.waitForTransactionReceipt({ hash });
  return { address: r.contractAddress!, abi: a.abi };
}

const mintAbi = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
] as const;

async function send(account: PrivateKeyAccount, to: Address, abi: Abi, functionName: string, args: unknown[], value?: bigint) {
  const hash = await wallet(account).writeContract({ address: to, abi, functionName, args, value } as never);
  const r = await anvil.waitForTransactionReceipt({ hash });
  expect(r.status).toBe("success");
  return hash;
}

// --- stand-in Safe Transaction Service ---------------------------------------------------------
interface Queued {
  safeTxHash: Hex;
  to: Address;
  value: string;
  data: Hex;
  operation: number;
  nonce: number;
  isExecuted: boolean;
  isSuccessful: boolean | null;
  transactionHash: Hex | null;
}
const queue: Queued[] = [];
let server: Server;
let safeAbi: Abi;
let SAFE: Address;

function startService() {
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && url.pathname === `/api/v1/safes/${SAFE}/`) {
        const nonce = await anvil.readContract({ address: SAFE, abi: safeAbi, functionName: "nonce" });
        return reply(200, { nonce: Number(nonce) });
      }
      if (req.method === "GET" && url.pathname === `/api/v1/safes/${SAFE}/multisig-transactions/`) {
        return reply(200, { results: queue.filter((q) => !q.isExecuted).sort((a, b) => b.nonce - a.nonce) });
      }
      if (req.method === "POST" && url.pathname === `/api/v1/safes/${SAFE}/multisig-transactions/`) {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const b = JSON.parse(raw);
        const onchain = await anvil.readContract({
          address: SAFE,
          abi: safeAbi,
          functionName: "getTransactionHash",
          args: [b.to, BigInt(b.value), b.data, b.operation, 0n, 0n, 0n, zeroAddress, zeroAddress, BigInt(b.nonce)],
        });
        if (onchain !== b.contractTransactionHash) return reply(422, { error: "contractTransactionHash mismatch" });
        const signer = await recoverAddress({ hash: b.contractTransactionHash, signature: b.signature });
        if (signer.toLowerCase() !== String(b.sender).toLowerCase()) return reply(422, { error: "bad delegate signature" });
        queue.push({ ...b, safeTxHash: b.contractTransactionHash, isExecuted: false, isSuccessful: null, transactionHash: null });
        return reply(201, {});
      }
      const m = url.pathname.match(/^\/api\/v1\/multisig-transactions\/(0x[0-9a-fA-F]{64})\/$/);
      if (req.method === "GET" && m) {
        const q = queue.find((x) => x.safeTxHash === m[1]);
        return q ? reply(200, q) : reply(404, {});
      }
      reply(404, { error: `unhandled ${req.method} ${url.pathname}` });
    } catch (err) {
      reply(500, { error: String(err) });
    }
  });
  return new Promise<void>((resolve) => server.listen(SERVICE_PORT, "127.0.0.1", resolve));
}

/** Owners sign the queued Safe tx and one of them executes it (what Safe{Wallet} does). */
async function ownersExecute(q: Queued) {
  const sigs = await Promise.all(
    [owner1, owner2]
      .sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1))
      .map((o) => o.sign({ hash: q.safeTxHash })),
  );
  const hash = await wallet(owner1).writeContract({
    address: SAFE,
    abi: safeAbi,
    functionName: "execTransaction",
    args: [q.to, BigInt(q.value), q.data, q.operation, 0n, 0n, 0n, zeroAddress, zeroAddress, `0x${sigs.map((s) => s.slice(2)).join("")}`],
  } as never);
  const r = await anvil.waitForTransactionReceipt({ hash });
  Object.assign(q, { isExecuted: true, isSuccessful: r.status === "success", transactionHash: hash });
  return r;
}

// modules are imported after the env points at this test's contracts
let mod: {
  db: typeof import("../../src/db/pool.js").db;
  redis: typeof import("../../src/redis.js").redis;
  closeQueues: typeof import("../../src/queues.js").closeQueues;
  executeDueCycle: typeof import("../../src/modules/rewards/executor.js").executeDueCycle;
  recordAcquisitions: typeof import("../../src/modules/rewards/executor.js").recordAcquisitions;
  indexStaking: typeof import("../../src/modules/staking/indexer.js").indexStaking;
  lookup: typeof import("../../src/modules/lookup/service.js").lookup;
  cycleExecutionStatus: typeof import("../../src/modules/admin/service.js").cycleExecutionStatus;
};
let STAKING: { address: Address; abi: Abi };
let ZEC: Address;
let NVDA: Address;
let swapTx: Hex;

beforeAll(async () => {
  const sc = "node_modules/@safe-global/safe-contracts/build/artifacts/contracts";
  const singleton = await deploy(`${sc}/SafeL2.sol/SafeL2.json`);
  const factory = await deploy(`${sc}/proxies/SafeProxyFactory.sol/SafeProxyFactory.json`);
  const multiSend = await deploy(`${sc}/libraries/MultiSendCallOnly.sol/MultiSendCallOnly.json`);
  safeAbi = singleton.abi;

  const setup = encodeFunctionData({
    abi: singleton.abi,
    functionName: "setup",
    args: [[owner1.address, owner2.address], 2n, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress],
  });
  const { result, request } = await anvil.simulateContract({
    account: deployer,
    address: factory.address,
    abi: factory.abi,
    functionName: "createProxyWithNonce",
    args: [singleton.address, setup, 1n],
  } as never);
  await anvil.waitForTransactionReceipt({ hash: await wallet(deployer).writeContract(request as never) });
  SAFE = result as Address;

  const token = async () => {
    const hash = await wallet(deployer).deployContract({ abi: mintAbi, bytecode: TEST_USDC_BYTECODE });
    return (await anvil.waitForTransactionReceipt({ hash })).contractAddress!;
  };
  const noma = await token();
  ZEC = await token();
  NVDA = await token();
  STAKING = await deploy("../contracts/out/NomaStaking.sol/NomaStaking.json", [noma, admin.address, SAFE, BigInt(WEEK), BigInt(WEEK)]);
  const escrow = await deploy("../contracts/out/MockPonsFeeEscrow.sol/MockPonsFeeEscrow.json");
  // one week of creator fees credited to the Safe (the Pons creator fee recipient)
  await send(deployer, escrow.address, escrow.abi, "credit", [SAFE], parseEther("1"));

  Object.assign(process.env, {
    SAFE_ADDRESS: SAFE,
    SAFE_PROPOSER_PRIVATE_KEY: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
    SAFE_TX_SERVICE_URL: `http://127.0.0.1:${SERVICE_PORT}`,
    SAFE_MULTISEND_CALL_ONLY: multiSend.address,
    PONS_FEE_ESCROW: escrow.address,
    NOMA_QUOTE_ASSET: "ETH",
    NOMA_TOKEN_ADDRESS: noma,
    ZEC_TOKEN_ADDRESS: ZEC,
    NOMA_STAKING_ADDRESS: STAKING.address,
    REWARD_INDEXER_START_BLOCK: String(await anvil.getBlockNumber()),
    NOMA_BONDING_CURVE: "",
    PONS_V2_MEME_HOOK: "",
  });
  mod = {
    ...(await import("../../src/db/pool.js")),
    ...(await import("../../src/redis.js")),
    ...(await import("../../src/queues.js")),
    ...(await import("../../src/modules/rewards/executor.js")),
    ...(await import("../../src/modules/staking/indexer.js")),
    ...(await import("../../src/modules/lookup/service.js")),
    ...(await import("../../src/modules/admin/service.js")),
  } as typeof mod;
  await startService();

  await mod.db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = path.resolve("migrations");
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    await mod.db.query(await readFile(path.join(dir, f), "utf8"));
  }
  await mod.redis.flushdb();
  await mod.redis.set("price:ETH", "3000");

  // a staker, and a cycle that has just ended
  await send(deployer, noma, mintAbi, "mint", [staker.address, 100n * U]);
  await send(staker, noma, [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }], "approve", [STAKING.address, 100n * U]);
  await send(staker, STAKING.address, STAKING.abi, "stake", [100n * U]);
  const now = Number((await anvil.getBlock()).timestamp);
  await mod.db.query(
    `INSERT INTO reward_cycles (week_no, stock_symbol, stock_token_address, starts_at, ends_at, status)
     VALUES (1, 'NVDA', $1, to_timestamp($2), to_timestamp($3), 'active')`,
    [NVDA.toLowerCase(), now - WEEK, now - 60],
  );
  await mod.indexStaking();
});

afterAll(async () => {
  server?.close();
  await mod?.closeQueues();
  await mod?.db.end();
  mod?.redis.disconnect();
});

describe("reward cycle via Safe multisig", () => {
  it("A: proposes sweep+claim; owners execute; claimed amount is recorded", async () => {
    await mod.executeDueCycle();
    expect(queue).toHaveLength(1);
    expect(queue[0]!.operation).toBe(0); // single call: plain CALL, no MultiSend needed
    const status = await mod.cycleExecutionStatus(1);
    expect(status.next_action).toMatch(/sign and execute the claim/);
    expect(status.proposals[0].calls).toEqual([expect.objectContaining({ label: "Pons Fee Escrow claim (ETH)" })]);

    await mod.executeDueCycle(); // not executed yet: nothing new is proposed
    expect(queue).toHaveLength(1);

    const r = await ownersExecute(queue[0]!);
    expect(r.status).toBe("success");
    expect(await anvil.getBalance({ address: SAFE })).toBe(parseEther("1"));

    await mod.executeDueCycle();
    const { rows } = await mod.db.query("SELECT amount, amount_usd FROM escrow_claims WHERE cycle_id = 1");
    expect(rows).toEqual([{ amount: parseEther("1").toString(), amount_usd: "3000.000000" }]);
    expect((await mod.cycleExecutionStatus(1)).next_action).toMatch(/swap 50\/50/);
  });

  it("B: owners swap (one Safe batch); the admin records it; a non-50/50 split is rejected", async () => {
    // stand-in for a DEX swap: the Safe spends 0.5 + 0.5 ETH, then receives ZEC + NVDA
    const dex = "0x000000000000000000000000000000000000dEaD" as Address;
    const safeTx = {
      to: dex,
      value: parseEther("1").toString(),
      data: "0x" as Hex,
      operation: 0,
      nonce: Number(await anvil.readContract({ address: SAFE, abi: safeAbi, functionName: "nonce" })),
    };
    const hash = (await anvil.readContract({
      address: SAFE,
      abi: safeAbi,
      functionName: "getTransactionHash",
      args: [dex, parseEther("1"), "0x", 0, 0n, 0n, 0n, zeroAddress, zeroAddress, BigInt(safeTx.nonce)],
    })) as Hex;
    const q = { ...safeTx, safeTxHash: hash, isExecuted: false, isSuccessful: null, transactionHash: null } as Queued;
    await ownersExecute(q);
    swapTx = q.transactionHash!;
    await send(deployer, ZEC, mintAbi, "mint", [SAFE, 400n * U]);
    await send(deployer, NVDA, mintAbi, "mint", [SAFE, 40n * U]);

    const half = parseEther("0.5").toString();
    await expect(
      mod.recordAcquisitions(1, {
        ZEC: { amount_in: parseEther("0.6").toString(), amount_out: (400n * U).toString(), tx_hash: swapTx },
        STOCK: { amount_in: parseEther("0.4").toString(), amount_out: (40n * U).toString(), tx_hash: swapTx },
      }),
    ).rejects.toThrow(/not 50% of the claim/);

    await mod.recordAcquisitions(1, {
      ZEC: { amount_in: half, amount_out: (400n * U).toString(), tx_hash: swapTx },
      STOCK: { amount_in: half, amount_out: (40n * U).toString(), tx_hash: swapTx },
    });
    const { rows } = await mod.db.query("SELECT asset, tx_hash FROM reward_acquisitions ORDER BY asset");
    expect(rows).toEqual([
      { asset: "STOCK", tx_hash: swapTx },
      { asset: "ZEC", tx_hash: swapTx },
    ]);
  });

  it("C: refuses to fund an asset NomaStaking does not list", async () => {
    await mod.executeDueCycle(); // logs the error, proposes nothing
    expect(queue.filter((q) => !q.isExecuted)).toHaveLength(0);
  });

  it("C: proposes approve+notifyReward as one MultiSend batch; owners execute; rewards stream to stakers", async () => {
    await send(admin, STAKING.address, STAKING.abi, "addRewardAsset", [ZEC]);
    await send(admin, STAKING.address, STAKING.abi, "addRewardAsset", [NVDA]);

    await mod.executeDueCycle();
    const fund = queue.at(-1)!;
    expect(fund.operation).toBe(1); // DELEGATECALL into MultiSendCallOnly
    expect(fund.to.toLowerCase()).toBe(process.env.SAFE_MULTISEND_CALL_ONLY!.toLowerCase());
    const status = await mod.cycleExecutionStatus(1);
    expect(status.proposals.at(-1).calls.map((c: { label: string }) => c.label)).toEqual([
      "approve ZEC → NomaStaking",
      `NomaStaking.notifyReward(ZEC, ${400n * U})`,
      "approve NVDA → NomaStaking",
      `NomaStaking.notifyReward(NVDA, ${40n * U})`,
    ]);

    const r = await ownersExecute(fund);
    expect(r.status).toBe("success");
    await mod.indexStaking();
    await mod.executeDueCycle();

    const { rows: cycle } = await mod.db.query("SELECT status FROM reward_cycles WHERE id = 1");
    expect(cycle[0].status).toBe("distributed");
    const { rows: notes } = await mod.db.query("SELECT asset, amount, amount_usd, cycle_id FROM reward_notifications ORDER BY asset");
    expect(notes).toEqual([
      { asset: "NVDA", amount: (40n * U).toString(), amount_usd: "1500.000000", cycle_id: 1 },
      { asset: "ZEC", amount: (400n * U).toString(), amount_usd: "1500.000000", cycle_id: 1 },
    ]);

    await anvil.increaseTime({ seconds: WEEK });
    await anvil.mine({ blocks: 1 });
    const l = await mod.lookup(staker.address);
    const claimable = Object.fromEntries(l.claimable.map((c) => [c.asset, BigInt(c.amount)]));
    expect(400n * U - claimable.ZEC!).toBeLessThanOrEqual(10n); // sole staker receives the whole stream
    expect(40n * U - claimable.NVDA!).toBeLessThanOrEqual(10n);
  });
});
