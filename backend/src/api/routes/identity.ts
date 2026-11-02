import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { previewAliases } from "../../modules/identity/service.js";
import { badRequest } from "../../lib/errors.js";

const body = z.object({
  product_id: z.string().uuid(),
  fields: z.record(z.string().max(500)).default({}),
});

function enabled(): boolean {
  return process.env.FEATURE_GHOST_CHECKOUT === "1";
}

export async function identityRoutes(app: FastifyInstance) {
  app.post("/identity/aliases", async (req) => {
    if (!enabled()) throw badRequest("ghost checkout is not enabled");
    const parsed = body.parse(req.body);
    return previewAliases(parsed.product_id, parsed.fields);
  });
}
