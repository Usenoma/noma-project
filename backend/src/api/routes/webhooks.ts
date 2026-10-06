import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notFound } from "../../lib/errors.js";
import { nudgeFulfillment } from "../../modules/fulfillment/service.js";
import { adapters } from "../../suppliers/registry.js";
import { webhookTokenMatches } from "../../suppliers/webhooks.js";

const params = z.object({ supplier: z.string().max(64), token: z.string().max(128) });
const orderQuery = z.object({ order: z.string().uuid().optional() });

/**
 * Supplier notifications only cut polling latency: a valid call re-checks the order right away
 * through the supplier's authenticated API. Nothing in the payload is trusted beyond naming the
 * order, so a forged or replayed call can at most trigger one extra status poll.
 */
export async function webhookRoutes(app: FastifyInstance) {
  // suppliers post JSON, forms or nothing at all; anything that is not JSON is ignored
  app.addContentTypeParser("*", (_req, _payload, done) => done(null, undefined));

  app.route({
    method: ["GET", "POST"],
    url: "/webhooks/suppliers/:supplier/:token",
    config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
    handler: async (req) => {
      const { supplier, token } = params.parse(req.params);
      const a = adapters().find((x) => x.id === supplier);
      if (!a || !webhookTokenMatches(supplier, token)) throw notFound("webhook");

      const query = req.query as Record<string, unknown>;
      const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
      const { order } = orderQuery.parse(query);
      const supplierOrderId = order ? null : (a.webhookOrderId?.({ ...query, ...body }) ?? null);
      if (order || supplierOrderId) {
        const nudged = await nudgeFulfillment(supplier, order ? { orderId: order } : { supplierOrderId: supplierOrderId! });
        req.log.info({ supplier, order, supplierOrderId, nudged }, "supplier webhook");
      }
      // always 2xx for a valid URL, so the supplier does not retry notifications we ignore
      return { ok: true };
    },
  });
}
