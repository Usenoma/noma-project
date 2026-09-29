import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { unauthorized } from "../../lib/errors.js";
import { verifyWalletAuth } from "../../lib/walletAuth.js";
import { createOrder, getOrderForWallet, getOrderWithKey, listOrdersForWallet } from "../../modules/orders/service.js";

const createBody = z.object({
  product_id: z.string().uuid(),
  fields: z.record(z.string().max(500)).default({}),
  pay_asset: z.enum(["USDC", "ETH"]),
  wallet: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
});

const header = (req: FastifyRequest, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

const walletFromHeaders = (req: FastifyRequest) =>
  verifyWalletAuth(header(req, "x-wallet-address"), header(req, "x-wallet-signature"), header(req, "x-wallet-timestamp"));

export async function orderRoutes(app: FastifyInstance) {
  app.post("/orders", async (req, reply) => {
    const body = createBody.parse(req.body);
    const { orderId, orderKey, invoice } = await createOrder({
      productId: body.product_id,
      fields: body.fields,
      payAsset: body.pay_asset,
      wallet: body.wallet,
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

  app.get("/orders", async (req) => {
    const wallet = await walletFromHeaders(req);
    if (!wallet) throw unauthorized("wallet signature required");
    return { orders: await listOrdersForWallet(wallet) };
  });
}
