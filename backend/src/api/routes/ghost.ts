import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { badRequest, HttpError, unauthorized } from "../../lib/errors.js";
import { header } from "../../lib/walletRequest.js";
import { redis } from "../../redis.js";
import { createProfile, deleteProfile, listProfiles, updateProfile } from "../../modules/ghost/profiles.js";
import { remainingBudget, setBudget } from "../../modules/ghost/payment.js";
import { GHOST_FIELDS, getRules, setRules } from "../../modules/ghost/rules.js";
import { chat, getMission, listMissions, receipt } from "../../modules/ghost/service.js";
import { authenticateVault, createVault, type GhostVault } from "../../modules/ghost/vault.js";

/** Ghost Agent is gated: with the flag off the routes answer "not enabled" at runtime. */
function enabled(): boolean {
  return process.env.FEATURE_GHOST_AGENT === "1";
}

const idParam = z.object({ id: z.string().uuid() });
const nameBody = z.object({ name: z.string().min(1).max(100) });
const rulesBody = z.object({
  rules: z.record(z.enum(GHOST_FIELDS), z.enum(["alias", "deny"])),
});
const permissionBody = z.object({
  decision: z.enum(["approve", "alias", "deny"]),
  value: z.string().min(1).max(500).optional(),
});
const purchaseBody = z.object({ decision: z.enum(["approve", "cancel"]) });
const chatBody = z.object({
  mission_id: z.string().uuid().optional(),
  message: z.string().min(1).max(2000),
  permission: permissionBody.optional(),
  purchase: purchaseBody.optional(),
});
const budgetBody = z.object({ max_usd: z.number().min(0).max(10_000) });

async function vaultOf(req: FastifyRequest): Promise<GhostVault> {
  const key = header(req, "x-ghost-key");
  if (!key) throw unauthorized("ghost vault key required");
  const vault = await authenticateVault(key);
  if (!vault) throw unauthorized("invalid ghost vault key");
  return vault;
}

/** Daily per-IP cap on the free agent chat (each call spends LLM tokens). */
async function chatIpGuard(req: FastifyRequest): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const key = `ghost:ip:${req.ip}:${day}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 86_400);
  if (n > config.GHOST_DAILY_IP_LIMIT) {
    throw new HttpError(429, "daily ghost agent limit reached; try again tomorrow");
  }
}

export async function ghostRoutes(app: FastifyInstance) {
  // create a vault; returns the key exactly once
  app.post(
    "/ghost/vault",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (_req, reply) => {
      if (!enabled()) throw badRequest("ghost agent is not enabled");
      return reply.status(201).send(await createVault());
    },
  );

  app.get("/ghost/vault", async (req) => {
    if (!enabled()) throw badRequest("ghost agent is not enabled");
    const vault = await vaultOf(req);
    const [profiles, rules, remaining] = await Promise.all([
      listProfiles(vault.id),
      getRules(vault.id),
      remainingBudget(vault.id),
    ]);
    return { key_last4: vault.keyLast4, budget_usd: vault.budgetUsd, remaining_usd: remaining, profiles, rules };
  });

  app.put("/ghost/budget", async (req) => {
    if (!enabled()) throw badRequest("ghost agent is not enabled");
    const vault = await vaultOf(req);
    const { max_usd } = budgetBody.parse(req.body);
    await setBudget(vault.id, max_usd);
    return { budget_usd: max_usd, remaining_usd: await remainingBudget(vault.id) };
  });

  app.post("/ghost/profiles", async (req, reply) => {
    if (!enabled()) throw badRequest("ghost agent is not enabled");
    const vault = await vaultOf(req);
    const { name } = nameBody.parse(req.body);
    return reply.status(201).send(await createProfile(vault.id, name));
  });

  app.patch("/ghost/profiles/:id", async (req) => {
    if (!enabled()) throw badRequest("ghost agent is not enabled");
    const vault = await vaultOf(req);
    const { id } = idParam.parse(req.params);
    const { name } = nameBody.parse(req.body);
    return updateProfile(vault.id, id, name);
  });

  app.delete("/ghost/profiles/:id", async (req, reply) => {
    if (!enabled()) throw badRequest("ghost agent is not enabled");
    const vault = await vaultOf(req);
    const { id } = idParam.parse(req.params);
    await deleteProfile(vault.id, id);
    return reply.status(204).send();
  });

  app.put("/ghost/rules", async (req) => {
    if (!enabled()) throw badRequest("ghost agent is not enabled");
    const vault = await vaultOf(req);
    const { rules } = rulesBody.parse(req.body);
    return { rules: await setRules(vault.id, rules) };
  });

  app.post(
    "/ghost/chat",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      if (!enabled()) throw badRequest("ghost agent is not enabled");
      const vault = await vaultOf(req);
      const body = chatBody.parse(req.body);
      await chatIpGuard(req);
      return chat(vault.id, body.mission_id, body.message, body.permission, body.purchase);
    },
  );

  app.get("/ghost/missions", async (req) => {
    if (!enabled()) throw badRequest("ghost agent is not enabled");
    const vault = await vaultOf(req);
    return { missions: await listMissions(vault.id) };
  });

  app.get("/ghost/missions/:id", async (req) => {
    if (!enabled()) throw badRequest("ghost agent is not enabled");
    const vault = await vaultOf(req);
    const { id } = idParam.parse(req.params);
    return getMission(vault.id, id);
  });

  app.get("/ghost/missions/:id/receipt", async (req) => {
    if (!enabled()) throw badRequest("ghost agent is not enabled");
    const vault = await vaultOf(req);
    const { id } = idParam.parse(req.params);
    return receipt(vault.id, id);
  });
}
