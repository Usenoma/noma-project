import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { alert, alertDeliveryConfigured } from "../../lib/alerts.js";
import { badRequest, unauthorized } from "../../lib/errors.js";
import {
  aiKeys,
  cycleExecutionStatus,
  manualRefund,
  revealNextCycle,
  revokeAiKey,
  scheduleCycle,
  setMarkup,
  setProductActive,
  setSupplierBalanceAlert,
  suppliers,
} from "../../modules/admin/service.js";
import { recordAcquisitions } from "../../modules/rewards/executor.js";
import { listPaymentClaims, resolvePaymentClaim } from "../../modules/payments/claims.js";
import { listRefunds, retryRefund, type RefundStatus } from "../../modules/refunds/service.js";
import { adapters } from "../../suppliers/registry.js";
import { webhookUrl } from "../../suppliers/webhooks.js";

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

  // URLs to register in the dashboards of suppliers that take one account-wide webhook
  app.get("/webhooks", async () => ({
    webhooks: Object.fromEntries(
      adapters()
        .filter((a) => a.webhookOrderId)
        .map((a) => [a.id, webhookUrl(a.id) ?? null]),
    ),
  }));

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

  // Retry a failed refund after the operator has fixed gas/float. Safe to call repeatedly: a
  // confirmed refund is rejected and the queue job uses a fresh id.
  app.post("/orders/:id/refund/retry", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { kind } = z
      .object({ kind: z.enum(["full", "overpayment"]).default("full") })
      .parse(req.body ?? {});
    await retryRefund(id, kind);
    return { ok: true };
  });

  // Ops console: refunds that need attention and a test alert for the configured channel.
  app.get("/refunds", async (req) => {
    const { status } = z
      .object({ status: z.enum(["pending", "sent", "confirmed", "failed"]).optional() })
      .parse(req.query);
    return { refunds: await listRefunds(status as RefundStatus | undefined) };
  });

  app.post("/alerts/test", async () => {
    await alert("test alert from admin console", { source: "admin" }, {
      kind: "action",
      key: `admin-test-alert:${Date.now()}`,
      cooldownSeconds: 0,
    });
    return { ok: true, delivery_configured: alertDeliveryConfigured() };
  });

  // Buyer-reported payments the watcher could not match. Accept credits the order; reject closes it.
  app.get("/payment-claims", async (req) => {
    const { status } = z
      .object({ status: z.enum(["open", "accepted", "rejected"]).optional() })
      .parse(req.query);
    return { claims: await listPaymentClaims(status) };
  });

  app.post("/payment-claims/:id/resolve", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        action: z.enum(["accept", "reject"]),
        note: z.string().max(500).optional(),
      })
      .parse(req.body);
    return resolvePaymentClaim(id, body.action, body.note);
  });

  // AI gateway keys: inspect the balance/usage, or revoke a leaked key.
  app.get("/ai/keys", async (req) => {
    const query = z.object({ key: z.string().uuid().optional(), order: z.string().uuid().optional() }).parse(req.query);
    return { keys: await aiKeys({ keyId: query.key, orderId: query.order }) };
  });

  app.post("/ai/keys/:id/revoke", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await revokeAiKey(id);
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

  // Reward cycle execution via the Safe: current step, queued Safe proposals, recorded amounts
  app.get("/cycles/:id", async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    return cycleExecutionStatus(id);
  });

  // Record the 50/50 swaps the Safe owners executed (until swap routing is automated)
  const swap = z.object({
    amount_in: z.string().regex(/^\d+$/),
    amount_out: z.string().regex(/^[1-9]\d*$/),
    tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  });
  app.post("/cycles/:id/acquisitions", async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const body = z.object({ ZEC: swap, STOCK: swap }).parse(req.body);
    try {
      await recordAcquisitions(id, body as Parameters<typeof recordAcquisitions>[1]);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    return { ok: true };
  });
}
