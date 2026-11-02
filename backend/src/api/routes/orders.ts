import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { unauthorized } from "../../lib/errors.js";
import { header, walletFromHeaders } from "../../lib/walletRequest.js";
import { verifyWalletAuth } from "../../lib/walletAuth.js";
import { issueWalletSession } from "../../lib/walletSession.js";
import { createOrder, getOrderForWallet, getOrderWithKey, listOrdersForWallet } from "../../modules/orders/service.js";
import { revokeOrderKey, rotateOrderKey } from "../../modules/ai/service.js";
import { createPaymentClaim } from "../../modules/payments/claims.js";

const createBody = z.object({
  product_id: z.string().uuid(),
  fields: z.record(z.string().max(500)).default({}),
  pay_asset: z.enum(["USDG", "ETH"]),
  wallet: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
});

const sessionBody = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  signature: z.string().min(1),
  timestamp: z.union([z.string(), z.number()]),
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/** An order is readable by its key holder or by the wallet that attached/paid for it. */
async function requireOrderAccess(req: FastifyRequest, id: string): Promise<void> {
  const orderKey = header(req, "x-order-key");
  if (orderKey) {
    await getOrderWithKey(id, orderKey);
    return;
  }
  const wallet = await walletFromHeaders(req);
  if (!wallet) throw unauthorized("order key or wallet signature required");
  await getOrderForWallet(id, wallet);
}

export async function orderRoutes(app: FastifyInstance) {
  // Exchange a fresh wallet signature for a short-lived, read-only order session. The signature
  // itself is never stored; the token only unlocks order reads.
  app.post("/auth/wallet", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const body = sessionBody.parse(req.body);
    const address = await verifyWalletAuth(body.address, body.signature, String(body.timestamp));
    if (!address) throw unauthorized("invalid or expired signature");
    return issueWalletSession(address);
  });

  // each order allocates a deposit address and an invoice
  app.post("/orders", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = createBody.parse(req.body);
    // Attaching a wallet is a claim about identity: require proof (a fresh signature or a read-only
    // wallet session) instead of trusting the address in the request body.
    let wallet: string | undefined;
    if (body.wallet) {
      const proved = await walletFromHeaders(req);
      if (!proved || proved.toLowerCase() !== body.wallet.toLowerCase()) {
        throw unauthorized("sign with this wallet to attach the order");
      }
      wallet = proved;
    }
    const { orderId, orderKey, invoice } = await createOrder({
      productId: body.product_id,
      fields: body.fields,
      payAsset: body.pay_asset,
      wallet,
    });
    // order_key is returned exactly once; only its hash is stored
    return reply.status(201).send({ order_id: orderId, order_key: orderKey, invoice });
  });

  app.get("/orders/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const orderKey = header(req, "x-order-key");
    if (orderKey) return getOrderWithKey(id, orderKey);
    const wallet = await walletFromHeaders(req);
    if (wallet) return getOrderForWallet(id, wallet);
    throw unauthorized("X-Order-Key or wallet signature required");
  });

  // A buyer reports a transfer the watcher could not match (wrong amount/asset, late, another
  // wallet). The server verifies the on-chain transfer; an admin resolves it. No auto-credit.
  app.post(
    "/orders/:id/payment-claim",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { tx_hash } = z
        .object({ tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) })
        .parse(req.body);
      const orderKey = header(req, "x-order-key");
      if (orderKey) await getOrderWithKey(id, orderKey);
      else {
        const wallet = await walletFromHeaders(req);
        if (!wallet) throw unauthorized("order key or wallet signature required");
        await getOrderForWallet(id, wallet);
      }
      return reply.status(201).send({ claim: await createPaymentClaim(id, tx_hash) });
    },
  );

  // Buyer key management: authenticated by the order key or the paying/attached wallet. Rotating
  // invalidates the old key immediately; revoking kills it but keeps the remaining credit for a
  // later rotation.
  app.post("/orders/:id/ai-key/rotate", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await requireOrderAccess(req, id);
    return rotateOrderKey(id);
  });

  app.post("/orders/:id/ai-key/revoke", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await requireOrderAccess(req, id);
    await revokeOrderKey(id);
    return { ok: true };
  });

  app.get("/orders", async (req) => {
    const wallet = await walletFromHeaders(req);
    if (!wallet) throw unauthorized("wallet signature or session required");
    const { limit, offset } = listQuery.parse(req.query);
    return listOrdersForWallet(wallet, { limit, offset });
  });
}
