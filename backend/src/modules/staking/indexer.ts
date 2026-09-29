import type { Address } from "viem";
import { config } from "../../config.js";
import { chain } from "../../chain/client.js";
import { nomaStakingAbi } from "../../chain/abis/index.js";
import { getCursor, setCursor, tx } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { assetSymbol, usdPerUnit, usdValue } from "./assets.js";

const CURSOR = "staking-indexer";
const MAX_RANGE = 5_000n;

/**
 * Indexes NomaStaking events into stakes / staking_events / reward_notifications / claims.
 * Each log is applied at most once (primary keys on tx hash + log index), in one DB transaction
 * together with the cursor, so a crash never double-applies a stake delta.
 */
export async function indexStaking(): Promise<void> {
  if (!config.NOMA_STAKING_ADDRESS) return;
  const client = chain();
  const head = await client.getBlockNumber();
  const cursor = (await getCursor(CURSOR)) ?? (config.REWARD_INDEXER_START_BLOCK ?? head) - 1n;
  const fromBlock = cursor + 1n;
  if (fromBlock > head) return;
  const toBlock = fromBlock + MAX_RANGE - 1n < head ? fromBlock + MAX_RANGE - 1n : head;

  const logs = await client.getContractEvents({
    address: config.NOMA_STAKING_ADDRESS as Address,
    abi: nomaStakingAbi,
    fromBlock,
    toBlock,
  });
  logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));

  const timestamps = new Map<bigint, Date>();
  for (const block of new Set(logs.map((l) => l.blockNumber))) {
    const b = await client.getBlock({ blockNumber: block });
    timestamps.set(block, new Date(Number(b.timestamp) * 1000));
  }

  await tx(async (q) => {
    for (const log of logs) {
      const ts = timestamps.get(log.blockNumber)!;
      const key = [log.transactionHash, log.logIndex] as const;

      const recordStakeEvent = async (user: string, kind: string, amount: bigint, apply: string, params: unknown[]) => {
        const { rows: cur } = await q.query<{ staked_amount: string }>(
          `INSERT INTO stakes (address) VALUES ($1) ON CONFLICT (address) DO UPDATE SET address = EXCLUDED.address
           RETURNING staked_amount`,
          [user],
        );
        const stakedBefore = BigInt(cur[0]!.staked_amount);
        const stakedAfter = kind === "stake" ? stakedBefore + amount : kind === "unstake_request" ? stakedBefore - amount : stakedBefore;
        const inserted = await q.query(
          `INSERT INTO staking_events (tx_hash, log_index, block, ts, address, kind, amount, staked_after)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
          [...key, log.blockNumber.toString(), ts, user, kind, amount.toString(), stakedAfter.toString()],
        );
        if (inserted.rowCount) await q.query(apply, [user, ...params]);
      };

      switch (log.eventName) {
        case "Staked": {
          const user = log.args.user!.toLowerCase();
          await recordStakeEvent(user, "stake", log.args.amount!, "UPDATE stakes SET staked_amount = staked_amount + $2, updated_at = now() WHERE address = $1", [
            log.args.amount!.toString(),
          ]);
          break;
        }
        case "UnstakeRequested": {
          const user = log.args.user!.toLowerCase();
          await recordStakeEvent(
            user,
            "unstake_request",
            log.args.amount!,
            `UPDATE stakes SET staked_amount = staked_amount - $2, pending_unstake = pending_unstake + $2,
               unlock_at = to_timestamp($3), updated_at = now() WHERE address = $1`,
            [log.args.amount!.toString(), Number(log.args.unlockAt!)],
          );
          break;
        }
        case "Withdrawn": {
          const user = log.args.user!.toLowerCase();
          await recordStakeEvent(
            user,
            "withdraw",
            log.args.amount!,
            `UPDATE stakes SET pending_unstake = GREATEST(pending_unstake - $2, 0),
               unlock_at = CASE WHEN pending_unstake - $2 > 0 THEN unlock_at END, updated_at = now() WHERE address = $1`,
            [log.args.amount!.toString()],
          );
          break;
        }
        case "RewardAdded": {
          const asset = log.args.asset!.toLowerCase();
          // the executor also writes this row (with cycle and USD value); whichever lands first wins the insert
          await q.query(
            `INSERT INTO reward_notifications (cycle_id, asset, asset_address, amount, stream_end, tx_hash, ts)
             VALUES ((SELECT id FROM reward_cycles WHERE status = 'executing' ORDER BY week_no DESC LIMIT 1),
                     $1, $2, $3, to_timestamp($4), $5, $6)
             ON CONFLICT (tx_hash, asset_address) DO UPDATE SET amount = EXCLUDED.amount, stream_end = EXCLUDED.stream_end, ts = EXCLUDED.ts`,
            [await assetSymbol(q, asset), asset, log.args.amount!.toString(), Number(log.args.periodFinish!), log.transactionHash, ts],
          );
          break;
        }
        case "Claimed": {
          const asset = log.args.asset!.toLowerCase();
          const amount = log.args.amount!;
          await q.query(
            `INSERT INTO claims (address, asset, asset_address, amount, amount_usd, tx_hash, log_index, ts)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
            [
              log.args.user!.toLowerCase(),
              await assetSymbol(q, asset),
              asset,
              amount.toString(),
              usdValue(amount, await usdPerUnit(q, asset)),
              ...key,
              ts,
            ],
          );
          break;
        }
      }
    }
    await setCursor(CURSOR, toBlock, q);
  });

  if (logs.length) logger.info({ fromBlock, toBlock, events: logs.length }, "staking-indexer range indexed");
}
