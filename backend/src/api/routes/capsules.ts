import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buyCapsule, getCapsule, listCapsules } from "../../modules/capsules/service.js";
import { badRequest, unauthorized } from "../../lib/errors.js";
import { walletFromHeaders } from "../../lib/walletRequest.js";

const slugParam = z.object({ slug: z.string().min(1).max(64) });

const buyBody = z.object({
  fields: z.record(z.string().max(500)).default({}),
  pay_asset: z.enum(["USDG", "ETH"]),
  wallet: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
});

/** Capsules are gated: with the flag off the routes answer 404 so nothing depends on them at launch. */
function enabled(): boolean {
  return process.env.FEATURE_CAPSULES === "1";
}

export async function capsuleRoutes(app: FastifyInstance) {
  app.get("/capsules", async () => {
    if (!enabled()) throw badRequest("capsules are not enabled");
    return { capsules: await listCapsules() };
  });

  app.get("/capsules/:slug", async (req) => {
    if (!enabled()) throw badRequest("capsules are not enabled");
    const { slug } = slugParam.parse(req.params);
    return getCapsule(slug);
  });

  app.post("/capsules/:slug/orders", async (req, reply) => {
    if (!enabled()) throw badRequest("capsules are not enabled");
    const { slug } = slugParam.parse(req.params);
    const body = buyBody.parse(req.body);
    let wallet: string | undefined;
    if (body.wallet) {
      const proved = await walletFromHeaders(req);
      if (!proved || proved.toLowerCase() !== body.wallet.toLowerCase()) {
        throw unauthorized("sign with this wallet to attach the capsule orders");
      }
      wallet = proved;
    }
    const result = await buyCapsule(slug, body.fields, body.pay_asset, wallet);
    return reply.status(201).send(result);
  });
}
