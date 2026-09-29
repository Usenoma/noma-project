import { decodeEventLog, encodeFunctionData, zeroAddress, type Address, type Hex } from "viem";
import { config } from "../../config.js";
import { executorWallet } from "../../chain/client.js";
import { sendOnce } from "../../chain/sendOnce.js";
import { chain } from "../../chain/client.js";
import { nomaStakingAbi, rewardVaultAbi } from "../../chain/abis/index.js";
import { db } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { usdPrice, type PayAsset } from "../payments/assets.js";
import { checkpointCycle, recordGenesis } from "../staking/service.js";
import { cyclePool } from "./poolMath.js";

const vault = () => config.REWARD_VAULT_ADDRESS as Address;
const quoteToken = (): Address => (config.NOMA_QUOTE_ASSET === "ETH" ? zeroAddress : (config.NOMA_QUOTE_ASSET as Address));

/**
 * Swap route + minimum output for quote → target token.
 * TODO: implement against the DEX on Robinhood Chain. Deliberately throws: swapping without a
 * real quote (minOut = 0) would expose the vault to sandwiching.
 */
async function quoteSwap(_tokenIn: Address, _tokenOut: Address, _amountIn: bigint): Promise<{ minAmountOut: bigint; route: Hex }> {
  throw new Error("swap routing not implemented");
}

const vaultCall = (purpose: string, data: Hex) => sendOnce(purpose, executorWallet(), { to: vault(), data });

/** USD value of a raw quote-asset amount (18 decimals), or null without a price. */
async function quoteUsd(raw: bigint): Promise<string | null> {
  try {
    return ((Number(raw) / 1e18) * (await usdPrice(config.NOMA_QUOTE_ASSET as PayAsset))).toFixed(6);
  } catch {
    return null;
  }
}

/**
 * Close the active cycle whose end time has passed:
 * checkpoint the ended stream → claim escrow → swap 50/50 → stream both assets into NomaStaking.
 */
export async function executeDueCycle(): Promise<void> {
  const { rows } = await db.query<{ id: number; week_no: number; stock_token_address: string | null }>(
    `UPDATE reward_cycles SET status = 'executing'
     WHERE status = 'active' AND ends_at <= now()
     RETURNING id, week_no, stock_token_address`,
  );
  const cycle = rows[0];
  if (!cycle) return;
  logger.info({ cycle: cycle.week_no }, "executing reward cycle");
  await runExecutor(cycle.id);
}

/** Resumable: every step is skipped if its record already exists. */
export async function runExecutor(cycleId: number): Promise<void> {
  const { rows } = await db.query<{ stock_token_address: string | null }>(
    "SELECT stock_token_address FROM reward_cycles WHERE id = $1 AND status = 'executing'",
    [cycleId],
  );
  if (!rows[0]) return;
  const stockToken = rows[0].stock_token_address as Address | null;
  if (!config.ZEC_TOKEN_ADDRESS) throw new Error("ZEC_TOKEN_ADDRESS not configured");
  if (!stockToken) throw new Error(`cycle ${cycleId} has no stock token address`);

  // 0. record what each staker received from the stream that just ended (collection entries),
  //    before this cycle's notification folds any remainder into a new stream
  await checkpointCycle(cycleId);
  const genesis = await recordGenesis(cycleId);
  if (genesis) logger.info({ cycleId, genesis }, "GENESIS stakers recorded");

  // 1. claim from Pons Fee Escrow into RewardVault
  const claimedBefore = await db.query("SELECT 1 FROM escrow_claims WHERE cycle_id = $1", [cycleId]);
  if (!claimedBefore.rowCount) {
    const receipt = await vaultCall(
      `claim:${cycleId}`,
      encodeFunctionData({ abi: rewardVaultAbi, functionName: "claimFromEscrow", args: [quoteToken()] }),
    );
    let amount = 0n;
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: rewardVaultAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "EscrowClaimed") amount += ev.args.amount;
      } catch {
        /* not a vault event */
      }
    }
    await db.query(
      "INSERT INTO escrow_claims (cycle_id, quote_asset, amount, tx_hash, ts) VALUES ($1, $2, $3, $4, now())",
      [cycleId, config.NOMA_QUOTE_ASSET, amount.toString(), receipt.transactionHash],
    );
  }

  // 2. split exactly 50/50 and acquire ZEC + Stock of the Week
  const { rows: sum } = await db.query<{ total: string }>(
    "SELECT COALESCE(sum(amount), 0) AS total FROM escrow_claims WHERE cycle_id = $1",
    [cycleId],
  );
  const pool = cyclePool(BigInt(sum[0]!.total), 0n);
  const targets = [
    { asset: "ZEC", token: config.ZEC_TOKEN_ADDRESS as Address, amountIn: pool.zec },
    { asset: "STOCK", token: stockToken, amountIn: pool.stock },
  ] as const;

  for (const t of targets) {
    const done = await db.query("SELECT 1 FROM reward_acquisitions WHERE cycle_id = $1 AND asset = $2", [cycleId, t.asset]);
    if (done.rowCount || t.amountIn === 0n) continue;
    const { minAmountOut, route } = await quoteSwap(quoteToken(), t.token, t.amountIn);
    const receipt = await vaultCall(
      `swap:${cycleId}:${t.asset}`,
      encodeFunctionData({
        abi: rewardVaultAbi,
        functionName: "swap",
        args: [quoteToken(), t.token, t.amountIn, minAmountOut, route],
      }),
    );
    let amountOut = 0n;
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: rewardVaultAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "Swapped") amountOut += ev.args.amountOut;
      } catch {
        /* not a vault event */
      }
    }
    await db.query(
      `INSERT INTO reward_acquisitions (cycle_id, asset, amount_in, amount_out, tx_hash, ts)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [cycleId, t.asset, t.amountIn.toString(), amountOut.toString(), receipt.transactionHash],
    );
  }

  // 3. RewardVault approves NomaStaking and calls notifyReward: streamed to stakers over 7 days
  const { rows: acquired } = await db.query<{ asset: "ZEC" | "STOCK"; amount_in: string; amount_out: string; stock_symbol: string }>(
    `SELECT a.asset, a.amount_in, a.amount_out, c.stock_symbol FROM reward_acquisitions a
     JOIN reward_cycles c ON c.id = a.cycle_id WHERE a.cycle_id = $1`,
    [cycleId],
  );
  for (const a of acquired) {
    const token = (a.asset === "ZEC" ? config.ZEC_TOKEN_ADDRESS! : stockToken).toLowerCase() as Address;
    const amount = BigInt(a.amount_out);
    if (amount === 0n) continue;
    const funded = await db.query("SELECT 1 FROM reward_notifications WHERE cycle_id = $1 AND asset_address = $2", [cycleId, token]);
    if (funded.rowCount) continue;

    const [listed] = await chain().readContract({
      address: config.NOMA_STAKING_ADDRESS as Address,
      abi: nomaStakingAbi,
      functionName: "rewardState",
      args: [token],
    });
    if (!listed) throw new Error(`${a.asset} token ${token} is not a NomaStaking reward asset: ADMIN must call addRewardAsset`);

    const receipt = await vaultCall(
      `fund:${cycleId}:${a.asset}`,
      encodeFunctionData({ abi: rewardVaultAbi, functionName: "fundStaking", args: [token, amount] }),
    );
    await db.query(
      `INSERT INTO reward_notifications (cycle_id, asset, asset_address, amount, amount_usd, stream_end, tx_hash)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6), $7)
       ON CONFLICT (tx_hash, asset_address) DO UPDATE SET cycle_id = EXCLUDED.cycle_id, amount_usd = EXCLUDED.amount_usd`,
      [
        cycleId,
        a.asset === "ZEC" ? "ZEC" : a.stock_symbol,
        token,
        amount.toString(),
        await quoteUsd(BigInt(a.amount_in)),
        config.REWARD_STREAM_DURATION,
        receipt.transactionHash,
      ],
    );
  }

  await db.query("UPDATE reward_cycles SET status = 'distributed' WHERE id = $1", [cycleId]);
  logger.info({ cycleId }, "cycle rewards streaming to stakers");
}
