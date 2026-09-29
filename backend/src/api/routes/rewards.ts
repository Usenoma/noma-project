import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { collection } from "../../modules/collection/service.js";
import { lookup } from "../../modules/lookup/service.js";
import { currentRewards, methodology, rewardHistory, rewardTransactions } from "../../modules/rewards/service.js";

/** Public, no auth: Reward Engine, Wallet Lookup, Collection. All read-only. */
export async function publicRewardRoutes(app: FastifyInstance) {
  app.get("/rewards/current", () => currentRewards());
  app.get("/rewards/history", async () => ({ cycles: await rewardHistory() }));
  app.get("/rewards/transactions", async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return { transactions: await rewardTransactions(limit) };
  });
  app.get("/rewards/methodology", () => methodology());

  app.get("/lookup/:address", (req) => lookup(z.object({ address: z.string() }).parse(req.params).address));
  app.get("/collection/:address", (req) => collection(z.object({ address: z.string() }).parse(req.params).address));
}
