import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import { readiness } from "../modules/health/monitor.js";
import { rateLimitRedis } from "../redis.js";
import { adminRoutes } from "./routes/admin.js";
import { agentRoutes } from "./routes/agent.js";
import { catalogRoutes } from "./routes/catalog.js";
import { orderRoutes } from "./routes/orders.js";
import { publicRewardRoutes } from "./routes/rewards.js";

export function buildServer(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // never log credentials
      redact: ["req.headers.authorization", 'req.headers["x-order-key"]', 'req.headers["x-wallet-signature"]'],
    },
    trustProxy: true,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
    if (err instanceof ZodError) return reply.status(400).send({ error: "invalid request", issues: err.issues });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    req.log.error(err);
    return reply.status(500).send({ error: "internal error" });
  });

  // per-IP limits, shared across API instances via Redis; tighter on routes that cost money
  app.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute", redis: rateLimitRedis() });

  // liveness (container healthcheck) and readiness (external uptime monitoring: DB, Redis, workers)
  app.get("/health", { config: { rateLimit: false } }, async () => ({ ok: true }));
  app.get("/ready", { config: { rateLimit: false } }, async (_req, reply) => {
    const r = await readiness();
    return reply.status(r.ok ? 200 : 503).send(r);
  });

  app.register(catalogRoutes);
  app.register(orderRoutes);
  app.register(publicRewardRoutes);
  app.register(agentRoutes);
  app.register(adminRoutes, { prefix: "/admin" });

  return app;
}
