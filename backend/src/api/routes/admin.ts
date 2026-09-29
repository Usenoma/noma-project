import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { unauthorized } from "../../lib/errors.js";
import {
  manualRefund,
  revealNextCycle,
  scheduleCycle,
  setMarkup,
  setProductActive,
  setSupplierBalanceAlert,
  suppliers,
} from "../../modules/admin/service.js";

const pct = z.number().min(0).max(5);
const markupBody = z
  .object({
    default: pct,
    esim: pct.optional(),
    ai_credits: pct.optional(),
    vpn: pct.optional(),
    proxy: pct.optional(),
    vps: pct.optional(),
    giftcard: pct.optional(),
  })
  .strict();

function tokenMatches(given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(config.ADMIN_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Internal only: bearer ADMIN_TOKEN. Should also sit behind a private network / VPN. */
export async function adminRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (req) => {
    if (!tokenMatches(req.headers.authorization?.replace(/^Bearer /, ""))) throw unauthorized();
  });

  app.put("/markup", async (req) => {
    await setMarkup(markupBody.parse(req.body));
    return { ok: true };
  });

  app.patch("/products/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    await setProductActive(id, active);
    return { ok: true };
  });

  app.get("/suppliers", async () => ({ suppliers: await suppliers() }));

  app.patch("/suppliers/:id", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { balance_alert_usd } = z.object({ balance_alert_usd: z.number().min(0) }).parse(req.body);
    await setSupplierBalanceAlert(id, balance_alert_usd);
    return { ok: true };
  });

  app.post("/orders/:id/refund", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await manualRefund(id);
    return { ok: true };
  });

  app.post("/cycles", async (req, reply) => {
    const body = z
      .object({
        week_no: z.number().int().positive(),
        stock_symbol: z.string().min(1).max(12),
        stock_token_address: z
          .string()
          .regex(/^0x[0-9a-fA-F]{40}$/)
          .optional(),
        starts_at: z.string().datetime(),
        ends_at: z.string().datetime(),
      })
      .parse(req.body);
    return reply.status(201).send(await scheduleCycle(body));
  });

  app.post("/cycles/reveal-next", () => revealNextCycle());
}
