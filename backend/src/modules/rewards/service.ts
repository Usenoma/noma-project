import { db } from "../../db/pool.js";
import { redis } from "../../redis.js";
import { currentMethodology } from "../distribution/methodology.js";

/** Live pool values, written by reward-indexer on every trade. Raw quote-asset units + USD. */
export interface LivePool {
  quote_asset: string;
  claimed: string;
  claimable: string;
  total: string;
  zec: string;
  stock: string;
  total_usd: string;
  zec_usd: string;
  stock_usd: string;
  updated_at: string;
}

export const livePoolKey = (cycleId: number) => `rewards:live:${cycleId}`;

interface ActiveCycle {
  id: number;
  week_no: number;
  stock_symbol: string;
  stock_token_address: string | null;
  starts_at: Date;
  ends_at: Date;
}

export async function activeCycle(): Promise<ActiveCycle | undefined> {
  const { rows } = await db.query<ActiveCycle>(
    `SELECT id, week_no, stock_symbol, stock_token_address, starts_at, ends_at
     FROM reward_cycles WHERE status = 'active'`,
  );
  return rows[0];
}

/** Only the active cycle's stock is ever returned; upcoming cycles are never exposed. */
export async function currentRewards() {
  const cycle = await activeCycle();
  if (!cycle) return { cycle: null };
  const live = (await redis.hgetall(livePoolKey(cycle.id))) as Partial<LivePool>;
  return {
    cycle: {
      week_no: cycle.week_no,
      stock_of_the_week: { symbol: cycle.stock_symbol, token_address: cycle.stock_token_address },
      starts_at: cycle.starts_at,
      next_distribution_at: cycle.ends_at,
    },
    pools: live.updated_at
      ? {
          quote_asset: live.quote_asset,
          zec_pool: { amount: live.zec, usd: live.zec_usd },
          stock_pool: { amount: live.stock, usd: live.stock_usd },
          total: { amount: live.total, usd: live.total_usd },
          updated_at: live.updated_at,
        }
      : null,
  };
}

export async function rewardHistory() {
  const { rows } = await db.query(
    `SELECT c.week_no, c.stock_symbol, c.ends_at,
       COALESCE((SELECT json_agg(json_build_object('asset', a.asset, 'amount_in', a.amount_in,
         'amount_out', a.amount_out, 'usd_value', a.usd_value, 'tx_hash', a.tx_hash))
         FROM reward_acquisitions a WHERE a.cycle_id = c.id), '[]') AS acquisitions,
       (SELECT COALESCE(sum(d.usd_value), 0) FROM distributions d
         WHERE d.cycle_id = c.id AND d.status = 'confirmed') AS distributed_usd,
       (SELECT count(DISTINCT d.address) FROM distributions d
         WHERE d.cycle_id = c.id AND d.status = 'confirmed') AS recipients
     FROM reward_cycles c
     WHERE c.status IN ('executing', 'distributed')
     ORDER BY c.week_no DESC`,
  );
  return rows;
}

export async function rewardTransactions(limit = 100) {
  const { rows } = await db.query(
    `SELECT * FROM (
       SELECT 'escrow_claim' AS kind, c.week_no, e.quote_asset AS asset, e.amount, e.amount_usd AS usd_value, e.tx_hash, e.ts
         FROM escrow_claims e JOIN reward_cycles c ON c.id = e.cycle_id
       UNION ALL
       SELECT 'acquisition', c.week_no, a.asset, a.amount_out, a.usd_value, a.tx_hash, a.ts
         FROM reward_acquisitions a JOIN reward_cycles c ON c.id = a.cycle_id
       UNION ALL
       SELECT 'distribution', c.week_no, d.asset, sum(d.amount), sum(d.usd_value), d.tx_hash, max(c.ends_at)
         FROM distributions d JOIN reward_cycles c ON c.id = d.cycle_id
         WHERE d.status = 'confirmed' GROUP BY c.week_no, d.asset, d.tx_hash
     ) t ORDER BY ts DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

export function methodology() {
  const m = currentMethodology();
  return {
    version: m.version,
    kind: m.kind,
    min_balance: m.minBalance.toString(),
    excluded_addresses: m.excluded,
    rules: [
      "Balance is read at the snapshot block at cycle end.",
      "Holders at or above the minimum balance are eligible.",
      "Protocol addresses (Pons curve, V4 pool/hook, fee escrow, RewardVault) and listed addresses are excluded.",
      "Each asset pool is split pro-rata by eligible balance; rounding dust rolls into the next cycle.",
    ],
  };
}
