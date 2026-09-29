import { getAddress, isAddress } from "viem";
import { db } from "../../db/pool.js";
import { badRequest } from "../../lib/errors.js";
import { activeCycle } from "../rewards/service.js";
import { position } from "../staking/service.js";

/** Read-only wallet lookup: paste an address, no connect, no signature. */
export async function lookup(raw: string) {
  if (!isAddress(raw)) throw badRequest("invalid address");
  const address = getAddress(raw);
  const lower = address.toLowerCase();

  const [pos, cycle, claimed, genesis] = await Promise.all([
    position(address),
    activeCycle(),
    db.query<{ asset: string; amount: string; usd: string }>(
      `SELECT asset, sum(amount) AS amount, COALESCE(sum(amount_usd), 0) AS usd
       FROM claims WHERE address = $1 GROUP BY asset ORDER BY asset`,
      [lower],
    ),
    db.query("SELECT 1 FROM genesis_holders WHERE address = $1", [lower]),
  ]);

  return {
    address,
    eligible: BigInt(pos.staked) > 0n, // only active stake earns; pending unstake does not
    staked: pos.staked,
    pending_unstake: pos.pending_unstake,
    unlock_at: pos.unlock_at,
    claimable: pos.claimable,
    total_claimed: claimed.rows,
    total_claimed_usd: claimed.rows.reduce((s, r) => s + Number(r.usd), 0).toFixed(2),
    genesis: (genesis.rowCount ?? 0) > 0,
    next_distribution_at: cycle?.ends_at ?? null,
  };
}
