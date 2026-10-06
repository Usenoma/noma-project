import { Worker, type Job, type Processor } from "bullmq";
import { chainConfigured } from "../chain/client.js";
import { assertNoSweeperSecrets } from "../config.js";
import { db } from "../db/pool.js";
import { alert } from "../lib/alerts.js";
import { logger } from "../lib/logger.js";
import { syncSupplierCatalog } from "../modules/catalog/service.js";
import { fulfill, markFulfillmentFailed, NUDGE_JOB, SupplierPendingError } from "../modules/fulfillment/service.js";
import { refreshEthPrice } from "../modules/payments/priceFeed.js";
import { watchPayments } from "../modules/payments/watcher.js";
import { checkHealth, markRun, workersHeartbeat } from "../modules/health/monitor.js";
import { processRefund, startRefund, type RefundKind } from "../modules/refunds/service.js";
import { advanceCycle, executeDueCycle } from "../modules/rewards/executor.js";
import { indexRewards } from "../modules/rewards/indexer.js";
import { indexStaking } from "../modules/staking/indexer.js";
import { closeQueues, QUEUE, queue, type QueueName } from "../queues.js";
import { bullConnection, redis } from "../redis.js";
import { adapter, adapters } from "../suppliers/registry.js";

async function supplierBalances() {
  for (const a of adapters()) {
    try {
      const balance = await a.balance();
      if (balance === null) continue; // not exposed by this supplier
      const { rows } = await db.query<{ balance_alert_usd: string | null }>(
        "UPDATE suppliers SET balance_usd = $2, updated_at = now() WHERE id = $1 RETURNING balance_alert_usd",
        [a.id, balance],
      );
      const threshold = rows[0]?.balance_alert_usd;
      if (threshold !== null && threshold !== undefined && balance < Number(threshold)) {
        await alert("supplier balance low", { supplier: a.id, balance_usd: balance, threshold_usd: Number(threshold) },{ key: `supplier-balance:${a.id}`, cooldownSeconds: 6 * 3600 });
      }
    } catch (err) {
      logger.error({ err, supplier: a.id }, "supplier balance check failed");
    }
  }
}

async function catalogSync() {
  for (const a of adapters()) {
    try {
      // suppliers with tight API quotas (e.g. Bitrefill) sync less often
      if (a.catalogTtlMinutes) {
        const fresh = await redis.set(`catalog-sync:${a.id}`, "1", "EX", a.catalogTtlMinutes * 60, "NX");
        if (!fresh) continue;
      }
      const count = await syncSupplierCatalog(a, await a.syncCatalog());
      logger.info({ supplier: a.id, count }, "catalog synced");
    } catch (err) {
      logger.error({ err, supplier: a.id }, "catalog sync failed");
      if (a.catalogTtlMinutes) await redis.del(`catalog-sync:${a.id}`); // retry on the next tick
    }
  }
}

/** Release rentals (e.g. VPS) whose period has ended. */
async function releaseExpiredResources() {
  const { rows } = await db.query<{ order_id: string; supplier_id: string; supplier_order_id: string }>(
    "SELECT order_id, supplier_id, supplier_order_id FROM supplier_resources WHERE released_at IS NULL AND expires_at <= now() LIMIT 50",
  );
  for (const r of rows) {
    try {
      await adapter(r.supplier_id).release?.(r.supplier_order_id);
      await db.query("UPDATE supplier_resources SET released_at = now() WHERE order_id = $1", [r.order_id]);
      logger.info({ orderId: r.order_id, supplier: r.supplier_id }, "rental released");
    } catch (err) {
      await alert("rental release failed (still billing)", { orderId: r.order_id, err: String(err) }, { key: `rental-release:${r.order_id}`, cooldownSeconds: 6 * 3600 });
    }
  }
}

const processors: Record<QueueName, Processor> = {
  [QUEUE.catalogSync]: catalogSync,
  [QUEUE.supplierBalance]: supplierBalances,
  [QUEUE.paymentWatcher]: async () => {
    await watchPayments();
    await markRun("payment-watcher");
  },
  [QUEUE.priceFeed]: refreshEthPrice,
  [QUEUE.resourceExpiry]: releaseExpiredResources,
  [QUEUE.fulfillment]: (job: Job<{ orderId: string }>) => fulfill(job.data.orderId),
  [QUEUE.refund]: (job: Job<{ orderId: string; kind?: RefundKind }>) => processRefund(job.data.orderId, job.data.kind),
  // Pons trade accruals + NomaStaking positions/claims/notifications
  [QUEUE.rewardIndexer]: async () => {
    await indexStaking();
    await indexRewards();
    await markRun("reward-indexer");
  },
  [QUEUE.rewardExecutor]: async (job: Job<{ cycleId?: number }>) =>
    job.data.cycleId ? advanceCycle(job.data.cycleId) : executeDueCycle(),
  // stale pollers, stuck RPC head, fulfillment failure rate
  [QUEUE.health]: checkHealth,
};

/** Repeatable schedules (backend.md §10). Chain workers only run once the chain is configured. */
const schedules: { queue: QueueName; everyMs: number; needsChain?: boolean }[] = [
  { queue: QUEUE.catalogSync, everyMs: 30 * 60_000 },
  { queue: QUEUE.supplierBalance, everyMs: 5 * 60_000 },
  { queue: QUEUE.priceFeed, everyMs: 30_000 },
  { queue: QUEUE.resourceExpiry, everyMs: 10 * 60_000 },
  { queue: QUEUE.paymentWatcher, everyMs: 10_000, needsChain: true },
  { queue: QUEUE.rewardIndexer, everyMs: 5_000, needsChain: true },
  { queue: QUEUE.rewardExecutor, everyMs: 60_000, needsChain: true },
  { queue: QUEUE.health, everyMs: 60_000 },
];

async function main() {
  assertNoSweeperSecrets("workers");
  for (const s of schedules) {
    if (s.needsChain && !chainConfigured) {
      logger.warn({ queue: s.queue }, "chain not configured, schedule skipped");
      continue;
    }
    await queue(s.queue).upsertJobScheduler(`${s.queue}-every`, { every: s.everyMs }, { name: s.queue });
  }

  const workers = (Object.entries(processors) as [QueueName, Processor][]).map(
    ([name, processor]) =>
      new Worker(name, processor, {
        connection: bullConnection(),
        // pollers must never overlap with themselves
        concurrency: name === QUEUE.fulfillment ? 5 : 1,
      }),
  );

  for (const w of workers) {
    w.on("failed", (job, err) => {
      const log = err instanceof SupplierPendingError ? logger.info.bind(logger) : logger.error.bind(logger);
      log({ queue: w.name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, job?.name === NUDGE_JOB ? "nudge failed" : "job failed, will retry");
    });
  }

  // fulfillment: retry with backoff; after the final attempt → failed → refund
  const fulfillmentWorker = workers.find((w) => w.name === QUEUE.fulfillment)!;
  fulfillmentWorker.on("failed", async (job, err) => {
    // a webhook nudge is an extra pass: only the order's own job decides that it failed
    if (!job || job.name === NUDGE_JOB || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    const { orderId } = job.data as { orderId: string };
    await markFulfillmentFailed(orderId, err.message);
    await startRefund(orderId).catch((e) => alert("refund could not start", { orderId, err: e.message }, { key: `refund-start:${orderId}` }));
  });

  logger.info({ workers: workers.map((w) => w.name) }, "workers started");
  await workersHeartbeat();
  const heartbeat = setInterval(() => void workersHeartbeat(), 30_000);

  const shutdown = async () => {
    clearInterval(heartbeat);
    await Promise.all(workers.map((w) => w.close()));
    await closeQueues();
    await db.end();
    redis.disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.error(err, "workers crashed");
  process.exit(1);
});
