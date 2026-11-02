import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listSubscriptions, recordDecision } from "../../modules/subscriptions/service.js";
import { badRequest, unauthorized } from "../../lib/errors.js";
import { walletFromHeaders } from "../../lib/walletRequest.js";

function enabled(): boolean {
  return process.env.FEATURE_SUBSCRIPTION_GUARDIAN === "1";
}

export async function subscriptionRoutes(app: FastifyInstance) {
  app.get("/subscriptions/:owner", async (req) => {
    if (!enabled()) throw badRequest("subscription guardian is not enabled");
    const { owner } = z
      .object({ owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/) })
      .parse(req.params);
    const wallet = await walletFromHeaders(req);
    if (!wallet || wallet.toLowerCase() !== owner.toLowerCase()) {
      throw unauthorized("sign with the wallet that owns these subscriptions");
    }
    return { subscriptions: await listSubscriptions(owner) };
  });

  app.post("/subscriptions/:id/decision", async (req) => {
    if (!enabled()) throw badRequest("subscription guardian is not enabled");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { decision } = z.object({ decision: z.enum(["keep", "cancel"]) }).parse(req.body);
    const wallet = await walletFromHeaders(req);
    if (!wallet) throw unauthorized("wallet signature required");
    await recordDecision(id, decision, wallet);
    return { ok: true };
  });
}
