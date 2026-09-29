import { getAddress, isAddress } from "viem";
import { db } from "../../db/pool.js";
import { badRequest } from "../../lib/errors.js";

/**
 * Per-wallet collection, built from staking rewards: one entry per (cycle, asset) the wallet
 * received (pro-rata to its stake over the stream), each with the notifyReward tx hash, plus the
 * wallet's claims (tx hashes of assets actually sent to it).
 */
export async function collection(raw: string) {
  if (!isAddress(raw)) throw badRequest("invalid address");
  const lower = raw.toLowerCase();

  const [entries, claims, genesis] = await Promise.all([
    db.query<{ week_no: number; asset_symbol: string; amount: string; usd_value: string | null; tx_hash: string }>(
      `SELECT c.week_no, e.asset_symbol, e.amount, e.usd_value, e.tx_hash
       FROM collection_entries e JOIN reward_cycles c ON c.id = e.cycle_id
       WHERE e.address = $1 ORDER BY c.week_no, e.asset_symbol`,
      [lower],
    ),
    db.query<{ asset: string; amount: string; amount_usd: string | null; tx_hash: string; ts: Date }>(
      "SELECT asset, amount, amount_usd, tx_hash, ts FROM claims WHERE address = $1 ORDER BY ts",
      [lower],
    ),
    db.query("SELECT 1 FROM genesis_holders WHERE address = $1", [lower]),
  ]);

  const perAsset = new Map<string, number>();
  for (const e of entries.rows) perAsset.set(e.asset_symbol, (perAsset.get(e.asset_symbol) ?? 0) + Number(e.usd_value ?? 0));

  return {
    address: getAddress(raw),
    genesis: (genesis.rowCount ?? 0) > 0,
    companies_count: [...perAsset.keys()].filter((s) => s !== "ZEC").length,
    entries: entries.rows,
    claims: claims.rows,
    usd_totals: Object.fromEntries([...perAsset].map(([k, v]) => [k, v.toFixed(2)])),
  };
}
