import { config } from "../../config.js";
import type { Queryable } from "../../db/pool.js";

/** Reward asset address → symbol: 'ZEC', or the stock symbol of the cycle that introduced it. */
export async function assetSymbol(q: Queryable, assetAddress: string): Promise<string> {
  if (config.ZEC_TOKEN_ADDRESS && assetAddress.toLowerCase() === config.ZEC_TOKEN_ADDRESS.toLowerCase()) return "ZEC";
  const { rows } = await q.query<{ stock_symbol: string }>(
    "SELECT stock_symbol FROM reward_cycles WHERE lower(stock_token_address) = lower($1) ORDER BY week_no LIMIT 1",
    [assetAddress],
  );
  return rows[0]?.stock_symbol ?? assetAddress.toLowerCase();
}

/** USD per raw unit of an asset, from its most recent notification that has a USD value. */
export async function usdPerUnit(q: Queryable, assetAddress: string): Promise<number | null> {
  const { rows } = await q.query<{ amount: string; amount_usd: string }>(
    `SELECT amount, amount_usd FROM reward_notifications
     WHERE lower(asset_address) = lower($1) AND amount_usd IS NOT NULL AND amount > 0
     ORDER BY ts DESC LIMIT 1`,
    [assetAddress],
  );
  const r = rows[0];
  return r ? Number(r.amount_usd) / Number(r.amount) : null;
}

export const usdValue = (amount: bigint, perUnit: number | null) =>
  perUnit === null ? null : (Number(amount) * perUnit).toFixed(6);
