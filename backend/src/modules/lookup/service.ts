import { getAddress, isAddress, type Address } from "viem";
import { config } from "../../config.js";
import { chain, chainConfigured } from "../../chain/client.js";
import { erc20Abi } from "../../chain/abis/index.js";
import { db } from "../../db/pool.js";
import { badRequest } from "../../lib/errors.js";
import { currentMethodology, isEligible } from "../distribution/methodology.js";
import { activeCycle } from "../rewards/service.js";

async function liveBalance(address: Address): Promise<bigint | null> {
  if (!chainConfigured || !config.NOMA_TOKEN_ADDRESS) return null;
  return chain().readContract({
    address: config.NOMA_TOKEN_ADDRESS as Address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
}

/** Read-only wallet lookup: no connect, no signature. */
export async function lookup(raw: string) {
  if (!isAddress(raw)) throw badRequest("invalid address");
  const address = getAddress(raw);
  const lower = address.toLowerCase();

  const [balance, cycle, totals, lastSnapshot] = await Promise.all([
    liveBalance(address),
    activeCycle(),
    db.query<{ asset: string; amount: string; usd_value: string }>(
      `SELECT asset, sum(amount) AS amount, COALESCE(sum(usd_value), 0) AS usd_value
       FROM distributions WHERE address = $1 AND status = 'confirmed' GROUP BY asset`,
      [lower],
    ),
    db.query<{ eligible: boolean; week_no: number }>(
      `SELECT sb.eligible, c.week_no FROM snapshot_balances sb
       JOIN snapshots s ON s.id = sb.snapshot_id JOIN reward_cycles c ON c.id = s.cycle_id
       WHERE sb.address = $1 ORDER BY s.id DESC LIMIT 1`,
      [lower],
    ),
  ]);

  const zec = totals.rows.find((r) => r.asset === "ZEC");
  const stocks = await db.query<{ asset_symbol: string }>(
    `SELECT DISTINCT asset_symbol FROM collection_entries WHERE address = $1 AND asset_symbol <> 'ZEC'`,
    [lower],
  );

  return {
    address,
    eligibility: {
      estimated_current: balance === null ? null : isEligible(lower, balance, currentMethodology()),
      noma_balance: balance?.toString() ?? null,
      last_snapshot: lastSnapshot.rows[0] ?? null,
    },
    zec_earned: zec ? { amount: zec.amount, usd: zec.usd_value } : { amount: "0", usd: "0" },
    stock_tokens_collected: stocks.rows.map((r) => r.asset_symbol),
    lifetime_rewards_usd: totals.rows.reduce((s, r) => s + Number(r.usd_value), 0).toFixed(2),
    next_distribution_at: cycle?.ends_at ?? null,
  };
}
