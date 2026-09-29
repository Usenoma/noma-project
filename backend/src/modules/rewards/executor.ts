import { decodeEventLog, encodeFunctionData, zeroAddress, type Address, type Hex } from "viem";
import { config } from "../../config.js";
import { executorWallet } from "../../chain/client.js";
import { sendOnce } from "../../chain/sendOnce.js";
import { rewardVaultAbi } from "../../chain/abis/index.js";
import { db } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { QUEUE, queue } from "../../queues.js";
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

/** Close the active cycle whose end time has passed: claim escrow → swap 50/50 → hand off to distributor. */
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

  await queue(QUEUE.distributor).add("distribute", { cycleId }, { jobId: `distribute-${cycleId}` });
}
