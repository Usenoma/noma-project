import { Queue, type DefaultJobOptions } from "bullmq";
import { bullConnection } from "./redis.js";

export const QUEUE = {
  catalogSync: "catalog-sync",
  paymentWatcher: "payment-watcher",
  priceFeed: "price-feed",
  resourceExpiry: "resource-expiry",
  fulfillment: "fulfillment",
  refund: "refund",
  supplierBalance: "supplier-balance-monitor",
  rewardIndexer: "reward-indexer",
  rewardExecutor: "reward-executor",
  health: "health-monitor",
  aiReaper: "ai-reservation-reaper",
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

const retry = (attempts: number, delay: number): DefaultJobOptions => ({
  attempts,
  backoff: { type: "exponential", delay },
  removeOnComplete: 1000,
  removeOnFail: 5000,
});

/** Event-driven jobs retry with backoff; repeatable pollers just run again on their next tick. */
const DEFAULT_JOB_OPTIONS: Partial<Record<QueueName, DefaultJobOptions>> = {
  [QUEUE.fulfillment]: retry(5, 30_000),
  [QUEUE.refund]: retry(10, 60_000),
  [QUEUE.rewardExecutor]: retry(5, 60_000),
};

const POLLER_OPTIONS: DefaultJobOptions = { removeOnComplete: 100, removeOnFail: 1000 };

const queues = new Map<QueueName, Queue>();

export function queue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: bullConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS[name] ?? POLLER_OPTIONS,
    });
    queues.set(name, q);
  }
  return q;
}

export async function closeQueues() {
  await Promise.all([...queues.values()].map((q) => q.close()));
}
