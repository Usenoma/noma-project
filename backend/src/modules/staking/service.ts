import type { Address } from "viem";
import { config } from "../../config.js";
import { chain, chainConfigured } from "../../chain/client.js";
import { nomaStakingAbi } from "../../chain/abis/index.js";
import { db, tx } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { assetSymbol, usdPerUnit, usdValue } from "./assets.js";

const stakingAddress = () => config.NOMA_STAKING_ADDRESS as Address;
export const stakingLive = () => chainConfigured && Boolean(config.NOMA_STAKING_ADDRESS);

const read = <T>(functionName: string, args: readonly unknown[] = [], blockNumber?: bigint) =>
  chain().readContract({
    address: stakingAddress(),
    abi: nomaStakingAbi,
    functionName: functionName as never,
    args: args as never,
    blockNumber,
  }) as Promise<T>;

export async function rewardAssets(blockNumber?: bigint): Promise<Address[]> {
  const n = await read<bigint>("rewardAssetsLength", [], blockNumber);
  return Promise.all(Array.from({ length: Number(n) }, (_, i) => read<Address>("rewardAssets", [BigInt(i)], blockNumber)));
}

/** Total active stake: live from the contract, indexed sum as fallback. */
export async function totalStaked(): Promise<string> {
  if (stakingLive()) return (await read<bigint>("totalStaked")).toString();
  const { rows } = await db.query<{ total: string }>("SELECT COALESCE(sum(staked_amount), 0) AS total FROM stakes");
  return rows[0]!.total;
}

export interface Position {
  staked: string;
  pending_unstake: string;
  unlock_at: string | null;
  claimable: { asset: string; asset_address: string; amount: string; usd: string | null }[];
}

/** Read-only position for Wallet Lookup (no wallet connection): live contract reads. */
export async function position(address: Address): Promise<Position> {
  if (!stakingLive()) {
    const { rows } = await db.query<{ staked_amount: string; pending_unstake: string; unlock_at: Date | null }>(
      "SELECT staked_amount, pending_unstake, unlock_at FROM stakes WHERE address = $1",
      [address.toLowerCase()],
    );
    const s = rows[0];
    return {
      staked: s?.staked_amount ?? "0",
      pending_unstake: s?.pending_unstake ?? "0",
      unlock_at: s?.unlock_at?.toISOString() ?? null,
      claimable: [],
    };
  }

  const [staked, pending, assets] = await Promise.all([
    read<bigint>("stakedOf", [address]),
    read<readonly [bigint, bigint]>("pendingUnstake", [address]),
    rewardAssets(),
  ]);
  const earned = await Promise.all(assets.map((a) => read<bigint>("earned", [address, a])));
  const claimable = await Promise.all(
    assets.map(async (a, i) => ({
      asset: await assetSymbol(db, a),
      asset_address: a.toLowerCase(),
      amount: earned[i]!.toString(),
      usd: usdValue(earned[i]!, await usdPerUnit(db, a)),
    })),
  );
  return {
    staked: staked.toString(),
    pending_unstake: pending[0].toString(),
    unlock_at: pending[0] > 0n ? new Date(Number(pending[1]) * 1000).toISOString() : null,
    claimable: claimable.filter((c) => c.amount !== "0"),
  };
}

/**
 * Cycle-end checkpoint. For every wallet that ever staked and every reward asset, reads the
 * cumulative reward (earned + claimed) at one block. The delta since the previous checkpoint is
 * what the wallet received from the stream that just ended (pro-rata to its stake over time,
 * as computed by the contract) and becomes a collection entry, attributed to the latest
 * notification of that asset (its cycle and tx hash). Idempotent per cycle.
 */
export async function checkpointCycle(cycleId: number): Promise<void> {
  if (!stakingLive()) return;
  const block = await chain().getBlockNumber();
  const assets = await rewardAssets(block);
  const { rows: stakers } = await db.query<{ address: Address }>("SELECT DISTINCT address FROM staking_events");

  const values: { address: string; asset: string; cumulative: bigint }[] = [];
  for (const { address } of stakers) {
    const reads = await Promise.all(
      assets.flatMap((a) => [read<bigint>("earned", [address, a], block), read<bigint>("totalClaimed", [a, address], block)]),
    );
    assets.forEach((a, i) => {
      const cumulative = reads[2 * i]! + reads[2 * i + 1]!;
      if (cumulative > 0n) values.push({ address, asset: a.toLowerCase(), cumulative });
    });
  }

  await tx(async (q) => {
    for (const v of values) {
      await q.query(
        `INSERT INTO reward_checkpoints (cycle_id, block, address, asset_address, cumulative)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [cycleId, block.toString(), v.address, v.asset, v.cumulative.toString()],
      );
    }

    // deltas vs. the previous checkpoint of the same wallet/asset
    const { rows: deltas } = await q.query<{ address: string; asset_address: string; delta: string }>(
      `SELECT c.address, c.asset_address, c.cumulative - COALESCE(p.cumulative, 0) AS delta
       FROM reward_checkpoints c
       LEFT JOIN LATERAL (
         SELECT cumulative FROM reward_checkpoints p
         WHERE p.address = c.address AND p.asset_address = c.asset_address AND p.block < c.block
         ORDER BY p.block DESC LIMIT 1
       ) p ON true
       WHERE c.cycle_id = $1 AND c.cumulative > COALESCE(p.cumulative, 0)`,
      [cycleId],
    );

    for (const d of deltas) {
      const { rows: n } = await q.query<{ cycle_id: number | null; asset: string; tx_hash: string; amount: string; amount_usd: string | null }>(
        `SELECT cycle_id, asset, tx_hash, amount, amount_usd FROM reward_notifications
         WHERE lower(asset_address) = $1 AND cycle_id IS NOT NULL AND cycle_id <> $2
         ORDER BY ts DESC LIMIT 1`,
        [d.asset_address, cycleId],
      );
      const notif = n[0];
      if (!notif) continue;
      const perUnit = notif.amount_usd ? Number(notif.amount_usd) / Number(notif.amount) : null;
      await q.query(
        `INSERT INTO collection_entries (address, cycle_id, asset_symbol, amount, usd_value, tx_hash)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (address, cycle_id, asset_symbol) DO UPDATE SET amount = EXCLUDED.amount, usd_value = EXCLUDED.usd_value`,
        [d.address, notif.cycle_id, notif.asset, d.delta, usdValue(BigInt(d.delta), perUnit), notif.tx_hash],
      );
    }
  });
  logger.info({ cycleId, wallets: stakers.length, assets: assets.length }, "reward checkpoint written");
}

/** GENESIS = every wallet with stake at any moment during the week-1 cycle. */
export async function recordGenesis(cycleId: number): Promise<number> {
  const { rowCount } = await db.query(
    `INSERT INTO genesis_holders (address, cycle_id)
     SELECT DISTINCT e.address, c.id FROM reward_cycles c
     JOIN staking_events e ON (
       -- staked (or still staked) during the window
       (e.ts BETWEEN c.starts_at AND c.ends_at AND (e.kind = 'stake' OR e.staked_after > 0))
       -- or entered the window with stake: last event before the start left stake > 0
       OR (e.ts < c.starts_at AND e.staked_after > 0 AND NOT EXISTS (
             SELECT 1 FROM staking_events l WHERE l.address = e.address AND l.ts > e.ts AND l.ts < c.starts_at))
     )
     WHERE c.id = $1 AND c.week_no = 1
     ON CONFLICT DO NOTHING`,
    [cycleId],
  );
  return rowCount ?? 0;
}

export function stakingMethodology() {
  return {
    version: "v2-staking",
    kind: "staking",
    unstake_cooldown_seconds: config.UNSTAKE_COOLDOWN,
    reward_stream_seconds: config.REWARD_STREAM_DURATION,
    rules: [
      "Only $NOMA staked in NomaStaking earns rewards; holding alone does not.",
      "Each cycle's rewards (50% ZEC, 50% Stock of the Week) are streamed to stakers over 7 days, pro-rata to stake over time.",
      "Unstaking stops earning immediately; tokens can be withdrawn after a 7-day cooldown.",
      "Rewards are claim-based (claimAll sends every asset in one transaction) and never expire.",
      "Rewards streamed while nobody is staked roll into the next stream.",
    ],
  };
}
