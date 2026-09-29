import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createTestClient, createWalletClient, http, publicActions, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { robinhoodChain } from "../../src/chain/client.js";
import { erc20Abi, nomaStakingAbi } from "../../src/chain/abis/index.js";
import { db } from "../../src/db/pool.js";
import { redis } from "../../src/redis.js";
import { closeQueues } from "../../src/queues.js";
import { collection } from "../../src/modules/collection/service.js";
import { lookup } from "../../src/modules/lookup/service.js";
import { currentRewards } from "../../src/modules/rewards/service.js";
import { indexStaking } from "../../src/modules/staking/indexer.js";
import { checkpointCycle, recordGenesis } from "../../src/modules/staking/service.js";
import { TEST_USDC_BYTECODE } from "../contracts/testUsdc.js";

// well-known anvil dev keys (accounts 2..6); public test keys, never used outside local chains
const admin = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const deployer = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const executor = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");
const alice = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const bob = privateKeyToAccount("0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e");

const WEEK = 7 * 24 * 3600;
const U = 1_000_000n; // test tokens have 6 decimals

const transport = http(config.CHAIN_RPC_URL);
const anvil = createTestClient({ mode: "anvil", chain: robinhoodChain, transport }).extend(publicActions);
const wallet = (account: typeof admin) => createWalletClient({ account, chain: robinhoodChain, transport });

const mintAbi = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
] as const;

const STAKING = config.NOMA_STAKING_ADDRESS as Address;
const ZEC = config.ZEC_TOKEN_ADDRESS as Address;
let NOMA: Address;
let NVDA: Address;

async function send(account: typeof admin, address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const hash = await wallet(account).writeContract({ address, abi, functionName, args } as never);
  const r = await anvil.waitForTransactionReceipt({ hash });
  expect(r.status).toBe("success");
  return hash;
}

async function deployToken(): Promise<Address> {
  const hash = await wallet(deployer).deployContract({ abi: mintAbi, bytecode: TEST_USDC_BYTECODE });
  return (await anvil.waitForTransactionReceipt({ hash })).contractAddress!;
}

async function timeTravel(seconds: number) {
  await anvil.increaseTime({ seconds });
  await anvil.mine({ blocks: 1 });
}

const near = (actual: string | bigint, expected: bigint, tolerance = 10n) => {
  const diff = BigInt(actual) - expected;
  expect(diff < 0n ? -diff : diff).toBeLessThanOrEqual(tolerance);
};

beforeAll(async () => {
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = path.resolve("migrations");
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    await db.query(await readFile(path.join(dir, f), "utf8"));
  }
  await redis.flushdb();

  // deployer nonces 0..3 → NOMA, ZEC, NVDA, NomaStaking (addresses precomputed in the config)
  NOMA = await deployToken();
  expect((await deployToken()).toLowerCase()).toBe(ZEC.toLowerCase());
  NVDA = await deployToken();

  const artifact = JSON.parse(
    await readFile(path.resolve("../contracts/out/NomaStaking.sol/NomaStaking.json"), "utf8"),
  ) as { abi: Abi; bytecode: { object: Hex } };
  const hash = await wallet(deployer).deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [NOMA, admin.address, executor.address, BigInt(WEEK), BigInt(WEEK)],
  });
  expect((await anvil.waitForTransactionReceipt({ hash })).contractAddress?.toLowerCase()).toBe(STAKING.toLowerCase());

  await send(admin, STAKING, nomaStakingAbi, "addRewardAsset", [ZEC]);
  await send(admin, STAKING, nomaStakingAbi, "addRewardAsset", [NVDA]);

  for (const user of [alice, bob]) {
    await send(deployer, NOMA, mintAbi, "mint", [user.address, 1_000n * U]);
    await send(user, NOMA, erc20Abi, "approve", [STAKING, 2n ** 255n]);
  }
  await send(deployer, ZEC, mintAbi, "mint", [executor.address, 10_000n * U]);
  await send(deployer, NVDA, mintAbi, "mint", [executor.address, 10_000n * U]);
  await send(executor, ZEC, erc20Abi, "approve", [STAKING, 2n ** 255n]);
  await send(executor, NVDA, erc20Abi, "approve", [STAKING, 2n ** 255n]);

  const now = Number((await anvil.getBlock()).timestamp);
  await db.query(
    `INSERT INTO reward_cycles (week_no, stock_symbol, stock_token_address, starts_at, ends_at, status, revealed_at) VALUES
     (1, 'NVDA', $1, to_timestamp($2), to_timestamp($3), 'active', now())`,
    [NVDA.toLowerCase(), now - 3600, now + WEEK],
  );
});

afterAll(async () => {
  await closeQueues();
  await db.end();
  redis.disconnect();
});

describe("staking rewards end to end", () => {
  it("indexes stakes and shows them in Wallet Lookup (no wallet connection)", async () => {
    await send(alice, STAKING, nomaStakingAbi, "stake", [300n * U]);
    await send(bob, STAKING, nomaStakingAbi, "stake", [100n * U]);
    await indexStaking();

    const { rows } = await db.query("SELECT address, staked_amount FROM stakes ORDER BY staked_amount DESC");
    expect(rows).toEqual([
      { address: alice.address.toLowerCase(), staked_amount: (300n * U).toString() },
      { address: bob.address.toLowerCase(), staked_amount: (100n * U).toString() },
    ]);
    const l = await lookup(alice.address);
    expect(l).toMatchObject({ eligible: true, staked: (300n * U).toString(), pending_unstake: "0", unlock_at: null });
    expect((await currentRewards()).total_staked).toBe((400n * U).toString());
  });

  it("cycle 1 ends: GENESIS recorded, rewards streamed and claimable pro-rata", async () => {
    await db.query("UPDATE reward_cycles SET status = 'executing' WHERE week_no = 1");
    await checkpointCycle(1); // nothing streamed yet
    expect(await recordGenesis(1)).toBe(2);

    // what the executor/RewardVault does: notifyReward for ZEC and the week's stock
    await send(executor, STAKING, nomaStakingAbi, "notifyReward", [ZEC, 400n * U]);
    await send(executor, STAKING, nomaStakingAbi, "notifyReward", [NVDA, 40n * U]);
    await indexStaking();
    await db.query("UPDATE reward_notifications SET amount_usd = amount / 1000000.0");
    const { rows: notes } = await db.query("SELECT cycle_id, asset, amount FROM reward_notifications ORDER BY asset");
    expect(notes).toEqual([
      { cycle_id: 1, asset: "NVDA", amount: (40n * U).toString() },
      { cycle_id: 1, asset: "ZEC", amount: (400n * U).toString() },
    ]);
    await db.query("UPDATE reward_cycles SET status = 'distributed' WHERE week_no = 1");

    await timeTravel(WEEK);
    const l = await lookup(alice.address);
    const claimable = Object.fromEntries(l.claimable.map((c) => [c.asset, c.amount]));
    near(claimable.ZEC!, 300n * U); // 75% of 400
    near(claimable.NVDA!, 30n * U);
    expect(l.genesis).toBe(true);
  });

  it("cycle 2 checkpoint turns received rewards into collection entries with tx hashes", async () => {
    const now = Number((await anvil.getBlock()).timestamp);
    await db.query(
      `INSERT INTO reward_cycles (week_no, stock_symbol, starts_at, ends_at, status) VALUES (2, 'TSLA', to_timestamp($1), to_timestamp($1), 'executing')`,
      [now],
    );
    const cycle2 = (await db.query<{ id: number }>("SELECT id FROM reward_cycles WHERE week_no = 2")).rows[0]!.id;
    await checkpointCycle(cycle2);
    await checkpointCycle(cycle2); // idempotent
    expect(await recordGenesis(cycle2)).toBe(0); // only week 1 grants GENESIS

    const c = await collection(alice.address);
    const byAsset = Object.fromEntries(c.entries.map((e) => [e.asset_symbol, e]));
    expect(c.genesis).toBe(true);
    expect(c.entries).toHaveLength(2);
    expect(byAsset.ZEC!.week_no).toBe(1);
    near(byAsset.ZEC!.amount, 300n * U);
    near(byAsset.NVDA!.amount, 30n * U);
    expect(byAsset.ZEC!.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(c.companies_count).toBe(1);
    near((await collection(bob.address)).entries.find((e) => e.asset_symbol === "ZEC")!.amount, 100n * U);
  });

  it("claimAll sends every asset in one tx; claims are indexed", async () => {
    const hash = await send(alice, STAKING, nomaStakingAbi, "claimAll", []);
    near(await anvil.readContract({ address: ZEC, abi: erc20Abi, functionName: "balanceOf", args: [alice.address] }), 300n * U);
    near(await anvil.readContract({ address: NVDA, abi: erc20Abi, functionName: "balanceOf", args: [alice.address] }), 30n * U);
    await indexStaking();

    const l = await lookup(alice.address);
    expect(l.claimable).toEqual([]);
    expect(l.total_claimed.map((c) => c.asset).sort()).toEqual(["NVDA", "ZEC"]);
    const { rows } = await db.query("SELECT DISTINCT tx_hash FROM claims WHERE address = $1", [alice.address.toLowerCase()]);
    expect(rows).toEqual([{ tx_hash: hash }]);
  });

  it("requestUnstake stops earning; lookup shows pending amount and unlock time", async () => {
    await send(alice, STAKING, nomaStakingAbi, "requestUnstake", [100n * U]);
    await indexStaking();
    const l = await lookup(alice.address);
    expect(l.staked).toBe((200n * U).toString());
    expect(l.pending_unstake).toBe((100n * U).toString());
    const now = Number((await anvil.getBlock()).timestamp);
    expect(Math.abs(new Date(l.unlock_at!).getTime() / 1000 - (now + WEEK))).toBeLessThanOrEqual(2);
    const { rows } = await db.query("SELECT staked_amount, pending_unstake FROM stakes WHERE address = $1", [alice.address.toLowerCase()]);
    expect(rows[0]).toEqual({ staked_amount: (200n * U).toString(), pending_unstake: (100n * U).toString() });
    expect((await currentRewards()).total_staked).toBe((300n * U).toString());
  });

  it("withdraw after the cooldown is indexed", async () => {
    await timeTravel(WEEK);
    await send(alice, STAKING, nomaStakingAbi, "withdraw", []);
    await indexStaking();
    const l = await lookup(alice.address);
    expect(l).toMatchObject({ pending_unstake: "0", unlock_at: null });
    const { rows } = await db.query("SELECT kind, count(*)::int AS n FROM staking_events GROUP BY kind ORDER BY kind");
    expect(rows).toEqual([
      { kind: "stake", n: 2 },
      { kind: "unstake_request", n: 1 },
      { kind: "withdraw", n: 1 },
    ]);
  });
});
