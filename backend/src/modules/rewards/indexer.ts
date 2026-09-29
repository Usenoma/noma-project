import { zeroAddress, type Address, type Hex } from "viem";
import { config } from "../../config.js";
import { chain } from "../../chain/client.js";
import { erc20Abi, ponsCurveAbi, ponsFeeEscrowAbi, ponsHookAbi } from "../../chain/abis/index.js";
import { db, getCursor, setCursor, tx } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { redis } from "../../redis.js";
import { usdPrice, type PayAsset } from "../payments/assets.js";
import { cyclePool } from "./poolMath.js";
import { activeCycle, livePoolKey } from "./service.js";

const CURSOR = "reward-indexer";
const MAX_RANGE = 2_000n;
const QUOTE_DECIMALS = 18; // TODO: read from pair token if NOMA_QUOTE_ASSET is not ETH

/** Quote asset as the Pons escrow keys it. TODO: confirm how the escrow represents native ETH. */
const quoteToken = (): Address => (config.NOMA_QUOTE_ASSET === "ETH" ? zeroAddress : (config.NOMA_QUOTE_ASSET as Address));

async function quoteUsd(raw: bigint): Promise<string | null> {
  try {
    const price = await usdPrice(config.NOMA_QUOTE_ASSET as PayAsset);
    return ((Number(raw) / 10 ** QUOTE_DECIMALS) * price).toFixed(6);
  } catch {
    return null;
  }
}

interface Accrual {
  source: "pons_curve" | "pons_v4_hook";
  txHash: Hex;
  logIndex: number;
  block: bigint;
  trader: Address;
  isBuy: boolean;
  quoteAmount: bigint;
  creatorFee: bigint;
}

/**
 * Indexes one block range: $NOMA Transfer events (holder balances) and Pons trade events
 * (creator-tax accruals), then refreshes the live pool for the public Reward Engine page.
 */
export async function indexRewards(): Promise<void> {
  if (!config.NOMA_TOKEN_ADDRESS) return;
  const client = chain();
  const head = await client.getBlockNumber();
  const cursor = (await getCursor(CURSOR)) ?? (config.REWARD_INDEXER_START_BLOCK ?? head) - 1n;
  const fromBlock = cursor + 1n;
  if (fromBlock > head) return refreshLivePool();
  const toBlock = fromBlock + MAX_RANGE - 1n < head ? fromBlock + MAX_RANGE - 1n : head;

  const [transfers, curveTrades, hookTrades] = await Promise.all([
    client.getContractEvents({
      address: config.NOMA_TOKEN_ADDRESS as Address,
      abi: erc20Abi,
      eventName: "Transfer",
      fromBlock,
      toBlock,
    }),
    config.NOMA_BONDING_CURVE
      ? client.getContractEvents({ address: config.NOMA_BONDING_CURVE as Address, abi: ponsCurveAbi, eventName: "Trade", fromBlock, toBlock })
      : Promise.resolve([]),
    config.PONS_V2_MEME_HOOK && config.NOMA_V4_POOL_ID
      ? client.getContractEvents({
          address: config.PONS_V2_MEME_HOOK as Address,
          abi: ponsHookAbi,
          eventName: "FeesCollected",
          args: { poolId: config.NOMA_V4_POOL_ID as Hex },
          fromBlock,
          toBlock,
        })
      : Promise.resolve([]),
  ]);

  const accruals: Accrual[] = [
    ...curveTrades.map((l) => ({
      source: "pons_curve" as const,
      txHash: l.transactionHash,
      logIndex: l.logIndex,
      block: l.blockNumber,
      trader: l.args.trader!,
      isBuy: l.args.isBuy!,
      quoteAmount: l.args.quoteAmount!,
      creatorFee: l.args.creatorFee!,
    })),
    ...hookTrades.map((l) => ({
      source: "pons_v4_hook" as const,
      txHash: l.transactionHash,
      logIndex: l.logIndex,
      block: l.blockNumber,
      trader: l.args.trader!,
      isBuy: l.args.isBuy!,
      quoteAmount: l.args.quoteAmount!,
      creatorFee: l.args.creatorFee!,
    })),
  ];

  const cycle = await activeCycle();
  const now = new Date();

  await tx(async (q) => {
    // net balance deltas per address for this range
    const deltas = new Map<string, bigint>();
    const bump = (a: string, d: bigint) => deltas.set(a, (deltas.get(a) ?? 0n) + d);
    for (const t of transfers) {
      const { from, to, value } = t.args;
      if (from && from !== zeroAddress) bump(from.toLowerCase(), -value!);
      if (to && to !== zeroAddress) bump(to.toLowerCase(), value!);
    }
    for (const [address, delta] of deltas) {
      await q.query(
        `INSERT INTO noma_balances (address, balance, updated_block) VALUES ($1, $2, $3)
         ON CONFLICT (address) DO UPDATE SET balance = noma_balances.balance + EXCLUDED.balance,
           updated_block = EXCLUDED.updated_block`,
        [address, delta.toString(), toBlock.toString()],
      );
    }

    for (const a of accruals) {
      // TODO: split creator-tax vs. creator's base-fee share once Pons event fields are confirmed (open decision #1)
      await q.query(
        `INSERT INTO fee_accruals (cycle_id, source, tx_hash, log_index, block, trader, side, quote_asset,
           trade_quote_amount, creator_tax_amount, amount_usd, ts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (tx_hash, log_index) DO NOTHING`,
        [
          cycle?.id ?? null,
          a.source,
          a.txHash,
          a.logIndex,
          a.block.toString(),
          a.trader.toLowerCase(),
          a.isBuy ? "buy" : "sell",
          config.NOMA_QUOTE_ASSET,
          a.quoteAmount.toString(),
          a.creatorFee.toString(),
          await quoteUsd(a.creatorFee),
          now, // TODO: use block timestamp
        ],
      );
    }
    await setCursor(CURSOR, toBlock);
  });

  if (accruals.length || transfers.length) {
    logger.info({ fromBlock, toBlock, trades: accruals.length, transfers: transfers.length }, "reward-indexer range indexed");
  }
  await refreshLivePool();
}

/** pool = claimed into RewardVault this cycle + still claimable in the Pons Fee Escrow. */
export async function refreshLivePool(): Promise<void> {
  const cycle = await activeCycle();
  if (!cycle || !config.PONS_FEE_ESCROW || !config.REWARD_VAULT_ADDRESS) return;

  const [{ rows }, claimable] = await Promise.all([
    db.query<{ claimed: string }>("SELECT COALESCE(sum(amount), 0) AS claimed FROM escrow_claims WHERE cycle_id = $1", [cycle.id]),
    chain().readContract({
      address: config.PONS_FEE_ESCROW as Address,
      abi: ponsFeeEscrowAbi,
      functionName: "claimable",
      args: [config.REWARD_VAULT_ADDRESS as Address, quoteToken()],
    }),
  ]);
  const pool = cyclePool(BigInt(rows[0]!.claimed), claimable);

  await redis.hset(livePoolKey(cycle.id), {
    quote_asset: config.NOMA_QUOTE_ASSET,
    claimed: rows[0]!.claimed,
    claimable: claimable.toString(),
    total: pool.total.toString(),
    zec: pool.zec.toString(),
    stock: pool.stock.toString(),
    total_usd: (await quoteUsd(pool.total)) ?? "",
    zec_usd: (await quoteUsd(pool.zec)) ?? "",
    stock_usd: (await quoteUsd(pool.stock)) ?? "",
    updated_at: new Date().toISOString(),
  });
}
