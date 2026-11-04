import rateLimit from "@fastify/rate-limit";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import { readiness } from "../modules/health/monitor.js";
import { rateLimitRedis } from "../redis.js";
import { adminRoutes } from "./routes/admin.js";
import { agentRoutes } from "./routes/agent.js";
import { aiRoutes } from "./routes/ai.js";
import { capsuleRoutes } from "./routes/capsules.js";
import { catalogRoutes } from "./routes/catalog.js";
import { ghostRoutes } from "./routes/ghost.js";
import { identityRoutes } from "./routes/identity.js";
import { orderRoutes } from "./routes/orders.js";
import { publicRewardRoutes } from "./routes/rewards.js";
import { subscriptionRoutes } from "./routes/subscriptions.js";
import { webhookRoutes } from "./routes/webhooks.js";

export function buildServer(logStream?: { write(line: string): void }): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      ...(logStream ? { stream: logStream } : {}),
      // never log credentials
      redact: ["req.headers.authorization", 'req.headers["x-order-key"]', 'req.headers["x-wallet-signature"]', 'req.headers["x-ghost-key"]'],
      serializers: {
        // supplier webhook URLs carry their secret in the path
        req: (req) => ({
          method: req.method,
          url: req.url.replace(/(\/webhooks\/suppliers\/[^/]+\/)[^/?]+/, "$1[redacted]"),
          host: req.host,
          remoteAddress: req.ip,
        }),
      },
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

  // per-IP limits, shared across API instances via Redis; tighter on routes that cost money.
  // Off in tests: every app.inject() call shares one IP, so a suite would trip the limiter.
  if (config.NODE_ENV !== "test") {
    app.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute", redis: rateLimitRedis() });
  }

  // the AI gateway is called from other apps/browsers; the bearer key is the auth
  app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "x-ghost-key"],
  });

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
  app.register(aiRoutes);
  app.register(webhookRoutes);
  // post-launch (gated by FEATURE_* env; answer "not enabled" until switched on)
  app.register(capsuleRoutes);
  app.register(subscriptionRoutes);
  app.register(identityRoutes);
  app.register(ghostRoutes);
  app.register(adminRoutes, { prefix: "/admin" });

  return app;
}
