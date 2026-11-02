import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, notFound } from "../../lib/errors.js";
import { countProducts, getProduct, listProducts, regionFacets } from "../../modules/catalog/service.js";

const listQuery = z.object({
  category: z.enum(["esim", "ai_credits", "vpn", "proxy", "vps", "giftcard"]).optional(),
  region: z.string().max(8).optional(),
  q: z.string().max(100).optional(),
  sort: z.enum(["price_asc", "price_desc", "title"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  max_price: z.coerce.number().min(0).optional(),
  specs: z.string().max(2000).optional(),
});

const specsSchema = z.record(z.number());

function specsOf(raw: string | undefined): Record<string, number> | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "specs must be valid JSON");
  }
  const result = specsSchema.safeParse(parsed);
  if (!result.success) throw new HttpError(400, "specs must be an object of numbers");
  return result.data;
}

export async function catalogRoutes(app: FastifyInstance) {
  app.get("/catalog", async (req) => {
    const parsed = listQuery.parse(req.query);
    const query = {
      category: parsed.category,
      region: parsed.region,
      q: parsed.q,
      sort: parsed.sort,
      maxPrice: parsed.max_price,
      specs: specsOf(parsed.specs),
      limit: parsed.limit,
      offset: parsed.offset,
    };
    const [products, total] = await Promise.all([listProducts(query), countProducts(query)]);
    return { products, total, limit: parsed.limit ?? 50, offset: parsed.offset ?? 0 };
  });

  // must be registered before /catalog/:id so "facets" is not parsed as a product id
  app.get("/catalog/facets", async (req) => {
    const parsed = listQuery.parse(req.query);
    const regions = await regionFacets({
      category: parsed.category,
      q: parsed.q,
      maxPrice: parsed.max_price,
      specs: specsOf(parsed.specs),
    });
    return { regions };
  });

  app.get("/catalog/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const product = await getProduct(id);
    if (!product) throw notFound("product");
    return product;
  });
}
