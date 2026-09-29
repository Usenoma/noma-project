import { getAddress, isAddress } from "viem";
import { db, type Queryable } from "../../db/pool.js";
import { badRequest } from "../../lib/errors.js";

export async function collection(raw: string) {
  if (!isAddress(raw)) throw badRequest("invalid address");
  const lower = raw.toLowerCase();

  const [entries, genesis] = await Promise.all([
    db.query<{ week_no: number; asset_symbol: string; amount: string; usd_value: string | null; tx_hash: string }>(
      `SELECT c.week_no, e.asset_symbol, e.amount, e.usd_value, e.tx_hash
       FROM collection_entries e JOIN reward_cycles c ON c.id = e.cycle_id
       WHERE e.address = $1 ORDER BY c.week_no, e.asset_symbol`,
      [lower],
    ),
    db.query("SELECT 1 FROM genesis_holders WHERE address = $1", [lower]),
  ]);

  const perAsset = new Map<string, number>();
  for (const e of entries.rows) perAsset.set(e.asset_symbol, (perAsset.get(e.asset_symbol) ?? 0) + Number(e.usd_value ?? 0));

  return {
    address: getAddress(raw),
    genesis: genesis.rowCount! > 0,
    companies_count: [...perAsset.keys()].filter((s) => s !== "ZEC").length,
    entries: entries.rows,
    usd_totals: Object.fromEntries([...perAsset].map(([k, v]) => [k, v.toFixed(2)])),
  };
}

/** Called after a distribution confirms: one collection entry per (address, asset); week-1 holders become GENESIS. */
export async function writeCollectionForCycle(q: Queryable, cycleId: number): Promise<void> {
  await q.query(
    `INSERT INTO collection_entries (address, cycle_id, asset_symbol, amount, usd_value, tx_hash)
     SELECT d.address, d.cycle_id,
            CASE WHEN d.asset = 'ZEC' THEN 'ZEC' ELSE c.stock_symbol END,
            d.amount, d.usd_value, d.tx_hash
     FROM distributions d JOIN reward_cycles c ON c.id = d.cycle_id
     WHERE d.cycle_id = $1 AND d.status = 'confirmed'
     ON CONFLICT DO NOTHING`,
    [cycleId],
  );
  await q.query(
    `INSERT INTO genesis_holders (address, snapshot_id)
     SELECT sb.address, s.id FROM snapshots s
     JOIN reward_cycles c ON c.id = s.cycle_id
     JOIN snapshot_balances sb ON sb.snapshot_id = s.id
     WHERE s.cycle_id = $1 AND c.week_no = 1 AND sb.eligible
     ON CONFLICT DO NOTHING`,
    [cycleId],
  );
}
