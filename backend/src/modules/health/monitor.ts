import { chain, chainConfigured } from "../../chain/client.js";
import { db } from "../../db/pool.js";
import { alert } from "../../lib/alerts.js";
import { redis } from "../../redis.js";

/** Pollers whose silence means money or rewards are not being tracked, with their max quiet time. */
export const WATCHED_POLLERS = {
  "payment-watcher": 3 * 60,
  "reward-indexer": 10 * 60,
} as const;
export type WatchedPoller = keyof typeof WATCHED_POLLERS;

/** The chain head is considered stuck when its latest block is older than this. */
const HEAD_STALE_SECONDS = 5 * 60;
/** Fulfillment failure rate over the last hour that triggers an alert (with a minimum count). */
const FAILURE_WINDOW = "1 hour";
const FAILURE_MIN_COUNT = 3;
const FAILURE_RATE = 0.25;

const lastRunKey = (p: WatchedPoller) => `health:last-run:${p}`;
const startedAt = Date.now();

/** Called after a poller pass completed without throwing. */
export async function markRun(poller: WatchedPoller): Promise<void> {
  await redis.set(lastRunKey(poller), String(Date.now()));
}

export function failureRateExceeded(failed: number, done: number): boolean {
  return failed >= FAILURE_MIN_COUNT && failed / (failed + done) >= FAILURE_RATE;
}

/**
 * Seconds a poller has been quiet, counted from its last pass or from this process start,
 * whichever is later: a (re)started worker gets a full window before anything is reported.
 */
export function quietSeconds(lastRunMs: number | null, nowMs: number, processStartMs: number): number {
  const since = Math.max(lastRunMs ?? 0, processStartMs);
  return (nowMs - since) / 1000;
}

/** Periodic health checks (workers, every minute). Each failing check raises its own alert. */
export async function checkHealth(): Promise<void> {
  const now = Date.now();

  if (chainConfigured) {
    for (const [poller, maxQuiet] of Object.entries(WATCHED_POLLERS) as [WatchedPoller, number][]) {
      const raw = await redis.get(lastRunKey(poller));
      const quiet = quietSeconds(raw ? Number(raw) : null, now, startedAt);
      if (quiet > maxQuiet) {
        await alert(
          `${poller} has not completed a pass for ${Math.round(quiet / 60)} min`,
          { poller, quiet_seconds: Math.round(quiet), last_run: raw ? new Date(Number(raw)).toISOString() : "never (since start)" },
          { key: `poller-quiet:${poller}`, cooldownSeconds: 30 * 60 },
        );
      }
    }

    try {
      const head = await chain().getBlock({ blockTag: "latest" });
      const age = now / 1000 - Number(head.timestamp);
      if (age > HEAD_STALE_SECONDS) {
        await alert("chain RPC head is stale", { block: head.number?.toString(), age_seconds: Math.round(age) }, { key: "rpc-head-stale", cooldownSeconds: 30 * 60 });
      }
    } catch (err) {
      await alert("chain RPC unreachable", { err: String(err).slice(0, 200) }, { key: "rpc-unreachable", cooldownSeconds: 30 * 60 });
    }
  }

  const { rows } = await db.query<{ failed: number; done: number }>(
    `SELECT count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*) FILTER (WHERE status = 'done')::int AS done
     FROM fulfillments WHERE updated_at > now() - interval '${FAILURE_WINDOW}'`,
  );
  const { failed, done } = rows[0]!;
  if (failureRateExceeded(failed, done)) {
    const top = await db.query<{ supplier_id: string; n: number }>(
      `SELECT supplier_id, count(*)::int AS n FROM fulfillments
       WHERE status = 'failed' AND updated_at > now() - interval '${FAILURE_WINDOW}' GROUP BY 1 ORDER BY 2 DESC LIMIT 3`,
    );
    await alert(
      "fulfillment failure rate high",
      { failed, done, window: FAILURE_WINDOW, by_supplier: Object.fromEntries(top.rows.map((r) => [r.supplier_id, r.n])) },
      { key: "fulfillment-failure-rate", cooldownSeconds: 2 * 3600 },
    );
  }
}
