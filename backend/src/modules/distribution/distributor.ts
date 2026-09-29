import { encodeFunctionData, type Address } from "viem";
import { config } from "../../config.js";
import { executorWallet } from "../../chain/client.js";
import { sendOnce } from "../../chain/sendOnce.js";
import { rewardVaultAbi } from "../../chain/abis/index.js";
import { db, getCursor, tx } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { QUEUE, queue } from "../../queues.js";
import { allocateProRata } from "./allocation.js";
import { currentMethodology, isEligible } from "./methodology.js";

const BATCH_SIZE = 200;

/** Snapshot eligible holders from indexed balances. Idempotent per cycle. */
async function snapshot(cycleId: number): Promise<number> {
  const existing = await db.query<{ id: number }>("SELECT id FROM snapshots WHERE cycle_id = $1", [cycleId]);
  if (existing.rows[0]) return existing.rows[0].id;

  const m = currentMethodology();
  const block = (await getCursor("reward-indexer")) ?? 0n;
  const { rows: holders } = await db.query<{ address: string; balance: string }>(
    "SELECT address, balance FROM noma_balances WHERE balance > 0",
  );
  const marked = holders.map((h) => ({ ...h, eligible: isEligible(h.address, BigInt(h.balance), m) }));
  const eligibleSupply = marked.filter((h) => h.eligible).reduce((s, h) => s + BigInt(h.balance), 0n);

  return tx(async (q) => {
    const { rows } = await q.query<{ id: number }>(
      `INSERT INTO snapshots (cycle_id, block, methodology_version, eligible_supply)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [cycleId, block.toString(), m.version, eligibleSupply.toString()],
    );
    const id = rows[0]!.id;
    for (let i = 0; i < marked.length; i += 1000) {
      const chunk = marked.slice(i, i + 1000);
      await q.query(
        `INSERT INTO snapshot_balances (snapshot_id, address, balance, eligible)
         SELECT $1, * FROM unnest($2::text[], $3::numeric[], $4::boolean[])`,
        [id, chunk.map((h) => h.address), chunk.map((h) => h.balance), chunk.map((h) => h.eligible)],
      );
    }
    return id;
  });
}

/** Create pending distribution rows (pro-rata per asset). Skips if rows already exist. */
async function allocate(cycleId: number, snapshotId: number): Promise<void> {
  const exists = await db.query("SELECT 1 FROM distributions WHERE cycle_id = $1 LIMIT 1", [cycleId]);
  if (exists.rowCount) return;

  const [{ rows: holders }, { rows: acquired }] = await Promise.all([
    db.query<{ address: string; balance: string }>(
      "SELECT address, balance FROM snapshot_balances WHERE snapshot_id = $1 AND eligible",
      [snapshotId],
    ),
    db.query<{ asset: "ZEC" | "STOCK"; amount_out: string; usd_value: string | null }>(
      "SELECT asset, amount_out, usd_value FROM reward_acquisitions WHERE cycle_id = $1",
      [cycleId],
    ),
  ]);
  const eligible = holders.map((h) => ({ address: h.address, balance: BigInt(h.balance) }));

  await tx(async (q) => {
    for (const acq of acquired) {
      const total = BigInt(acq.amount_out);
      const { allocations, dust } = allocateProRata(total, eligible);
      const usdPerUnit = acq.usd_value && total > 0n ? Number(acq.usd_value) / Number(total) : null;
      for (const a of allocations) {
        await q.query(
          `INSERT INTO distributions (cycle_id, address, asset, amount, usd_value) VALUES ($1, $2, $3, $4, $5)`,
          [cycleId, a.address, acq.asset, a.amount.toString(), usdPerUnit === null ? null : (Number(a.amount) * usdPerUnit).toFixed(6)],
        );
      }
      logger.info({ cycleId, asset: acq.asset, recipients: allocations.length, dust: dust.toString() }, "allocated");
    }
  });
}

/** Push pending allocations from RewardVault in batches; each batch is one tx. */
async function send(cycleId: number): Promise<void> {
  const { rows: cycle } = await db.query<{ stock_token_address: string }>(
    "SELECT stock_token_address FROM reward_cycles WHERE id = $1",
    [cycleId],
  );
  const tokenFor = { ZEC: config.ZEC_TOKEN_ADDRESS as Address, STOCK: cycle[0]!.stock_token_address as Address };
  const wallet = executorWallet();

  for (const asset of ["ZEC", "STOCK"] as const) {
    for (;;) {
      const { rows } = await db.query<{ id: string; address: Address; amount: string }>(
        `SELECT id, address, amount FROM distributions
         WHERE cycle_id = $1 AND asset = $2 AND status = 'pending' ORDER BY id LIMIT $3`,
        [cycleId, asset, BATCH_SIZE],
      );
      if (!rows.length) break;
      const ids = rows.map((r) => r.id);
      // batch composition is deterministic (ORDER BY id), so a resumed job gets the same purpose key
      const receipt = await sendOnce(`distribute:${cycleId}:${asset}:${ids[0]}-${ids.at(-1)}`, wallet, {
        to: config.REWARD_VAULT_ADDRESS as Address,
        data: encodeFunctionData({
          abi: rewardVaultAbi,
          functionName: "distribute",
          args: [tokenFor[asset], rows.map((r) => r.address), rows.map((r) => BigInt(r.amount))],
        }),
      });
      await db.query("UPDATE distributions SET status = 'confirmed', tx_hash = $2 WHERE id = ANY($1::bigint[])", [
        ids,
        receipt.transactionHash,
      ]);
    }
  }
}

export async function distributeCycle(cycleId: number): Promise<void> {
  const snapshotId = await snapshot(cycleId);
  await allocate(cycleId, snapshotId);

  if (!config.AUTO_DISTRIBUTION_ENABLED) {
    logger.warn({ cycleId }, "AUTO_DISTRIBUTION_ENABLED=false: allocations computed, not sent");
    return;
  }
  await send(cycleId);
  await db.query("UPDATE reward_cycles SET status = 'distributed' WHERE id = $1", [cycleId]);
  await queue(QUEUE.collection).add("collection", { cycleId }, { jobId: `collection-${cycleId}` });
}
