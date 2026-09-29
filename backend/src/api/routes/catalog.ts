import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getProduct, listProducts } from "../../modules/catalog/service.js";
import { notFound } from "../../lib/errors.js";

const listQuery = z.object({
  category: z.enum(["esim", "ai_credits", "vpn", "proxy", "vps", "giftcard"]).optional(),
  region: z.string().max(8).optional(),
  q: z.string().max(100).optional(),
  sort: z.enum(["price_asc", "price_desc", "title"]).optional(),
});

export async function catalogRoutes(app: FastifyInstance) {
  app.get("/catalog", async (req) => {
    const query = listQuery.parse(req.query);
    return { products: await listProducts(query) };
  });

  app.get("/catalog/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const product = await getProduct(id);
    if (!product) throw notFound("product");
    return product;
  });
}
