import { Worker, type Job, type Processor } from "bullmq";
import { chainConfigured } from "../chain/client.js";
import { db } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { syncSupplierCatalog } from "../modules/catalog/service.js";
import { writeCollectionForCycle } from "../modules/collection/service.js";
import { distributeCycle } from "../modules/distribution/distributor.js";
import { fulfill, markFulfillmentFailed, SupplierPendingError } from "../modules/fulfillment/service.js";
import { watchPayments } from "../modules/payments/watcher.js";
import { processRefund, startRefund } from "../modules/refunds/service.js";
import { executeDueCycle, runExecutor } from "../modules/rewards/executor.js";
import { indexRewards } from "../modules/rewards/indexer.js";
import { closeQueues, QUEUE, queue, type QueueName } from "../queues.js";
import { bullConnection, redis } from "../redis.js";
import { adapters } from "../suppliers/registry.js";

async function supplierBalances() {
  for (const a of adapters()) {
    try {
      const balance = await a.balance();
      const { rows } = await db.query<{ balance_alert_usd: string | null }>(
        "UPDATE suppliers SET balance_usd = $2, updated_at = now() WHERE id = $1 RETURNING balance_alert_usd",
        [a.id, balance],
      );
      const alert = rows[0]?.balance_alert_usd;
      if (alert !== null && alert !== undefined && balance < Number(alert)) {
        logger.warn({ supplier: a.id, balance, alert: Number(alert) }, "ALERT supplier balance low");
      }
    } catch (err) {
      logger.error({ err, supplier: a.id }, "supplier balance check failed");
    }
  }
}

async function catalogSync() {
  for (const a of adapters()) {
    try {
      const count = await syncSupplierCatalog(a, await a.syncCatalog());
      logger.info({ supplier: a.id, count }, "catalog synced");
    } catch (err) {
      logger.error({ err, supplier: a.id }, "catalog sync failed");
    }
  }
}

const processors: Record<QueueName, Processor> = {
  [QUEUE.catalogSync]: catalogSync,
  [QUEUE.supplierBalance]: supplierBalances,
  [QUEUE.paymentWatcher]: watchPayments,
  [QUEUE.fulfillment]: (job: Job<{ orderId: string }>) => fulfill(job.data.orderId),
  [QUEUE.refund]: (job: Job<{ orderId: string }>) => processRefund(job.data.orderId),
  [QUEUE.rewardIndexer]: indexRewards,
  [QUEUE.rewardExecutor]: async (job: Job<{ cycleId?: number }>) =>
    job.data.cycleId ? runExecutor(job.data.cycleId) : executeDueCycle(),
  [QUEUE.distributor]: (job: Job<{ cycleId: number }>) => distributeCycle(job.data.cycleId),
  [QUEUE.collection]: (job: Job<{ cycleId: number }>) => writeCollectionForCycle(db, job.data.cycleId),
};

/** Repeatable schedules (backend.md §10). Chain workers only run once the chain is configured. */
const schedules: { queue: QueueName; everyMs: number; needsChain?: boolean }[] = [
  { queue: QUEUE.catalogSync, everyMs: 30 * 60_000 },
  { queue: QUEUE.supplierBalance, everyMs: 5 * 60_000 },
  { queue: QUEUE.paymentWatcher, everyMs: 10_000, needsChain: true },
  { queue: QUEUE.rewardIndexer, everyMs: 5_000, needsChain: true },
  { queue: QUEUE.rewardExecutor, everyMs: 60_000, needsChain: true },
];

async function main() {
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
      log({ queue: w.name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, "job failed, will retry");
    });
  }

  // fulfillment: retry with backoff; after the final attempt → failed → refund
  const fulfillmentWorker = workers.find((w) => w.name === QUEUE.fulfillment)!;
  fulfillmentWorker.on("failed", async (job, err) => {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    const { orderId } = job.data as { orderId: string };
    await markFulfillmentFailed(orderId, err.message);
    await startRefund(orderId).catch((e) => logger.error({ orderId, err: e.message }, "ALERT refund could not start"));
  });

  logger.info({ workers: workers.map((w) => w.name) }, "workers started");

  const shutdown = async () => {
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
