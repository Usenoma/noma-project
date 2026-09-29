import { db, getSetting } from "../../db/pool.js";
import type { Category, NormalizedProduct, RequiredField, SupplierAdapter } from "../../suppliers/types.js";
import { applyMarkup, type MarkupConfig } from "./pricing.js";

export interface Product {
  id: string;
  supplier_id: string;
  category: Category;
  title: string;
  region: string | null;
  specs: Record<string, unknown>;
  price_usd: string;
  required_fields: RequiredField[];
}

const PUBLIC_COLUMNS = "id, supplier_id, category, title, region, specs, price_usd, required_fields";

export interface CatalogQuery {
  category?: Category;
  region?: string;
  q?: string;
  sort?: "price_asc" | "price_desc" | "title";
  maxPrice?: number;
  specs?: Record<string, number>; // minimum numeric spec values, e.g. { data_gb: 20 }
  limit?: number;
}

const SORTS = {
  price_asc: "price_usd ASC",
  price_desc: "price_usd DESC",
  title: "title ASC",
} as const;

export async function listProducts(query: CatalogQuery): Promise<Product[]> {
  const where = ["active"];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };

  if (query.category) add("category = ?", query.category);
  if (query.region) add("upper(region) = upper(?)", query.region);
  if (query.q) add("to_tsvector('simple', title) @@ plainto_tsquery('simple', ?)", query.q);
  if (query.maxPrice !== undefined) add("price_usd <= ?", query.maxPrice);
  for (const [key, min] of Object.entries(query.specs ?? {})) {
    if (!/^[a-z0-9_]+$/.test(key)) continue;
    add(`(specs->>'${key}')::numeric >= ?`, min);
  }

  params.push(Math.min(query.limit ?? 50, 200));
  const { rows } = await db.query<Product>(
    `SELECT ${PUBLIC_COLUMNS} FROM products WHERE ${where.join(" AND ")}
     ORDER BY ${SORTS[query.sort ?? "price_asc"]} LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function getProduct(id: string): Promise<Product | undefined> {
  const { rows } = await db.query<Product>(`SELECT ${PUBLIC_COLUMNS} FROM products WHERE id = $1 AND active`, [id]);
  return rows[0];
}

export async function getProducts(ids: string[]): Promise<Product[]> {
  const { rows } = await db.query<Product>(
    `SELECT ${PUBLIC_COLUMNS} FROM products WHERE id = ANY($1::uuid[]) AND active`,
    [ids],
  );
  return rows;
}

/** Upsert a supplier's normalized catalog and deactivate SKUs the supplier no longer lists. */
export async function syncSupplierCatalog(adapter: SupplierAdapter, products: NormalizedProduct[]): Promise<number> {
  const markup = (await getSetting<MarkupConfig>("markup_pct")) ?? { default: 0.08 };
  await db.query(
    `INSERT INTO suppliers (id, name, category) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
    [adapter.id, adapter.name, adapter.category],
  );

  for (const p of products) {
    await db.query(
      `INSERT INTO products (supplier_id, supplier_sku, category, title, region, specs, cost_usd, price_usd, required_fields, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (supplier_id, supplier_sku) DO UPDATE SET
         title = EXCLUDED.title, region = EXCLUDED.region, specs = EXCLUDED.specs,
         cost_usd = EXCLUDED.cost_usd, price_usd = EXCLUDED.price_usd,
         required_fields = EXCLUDED.required_fields, synced_at = now()`,
      [
        adapter.id,
        p.supplierSku,
        p.category,
        p.title,
        p.region,
        JSON.stringify(p.specs),
        p.costUsd,
        applyMarkup(p.costUsd, p.category, markup),
        JSON.stringify(p.requiredFields),
      ],
    );
  }

  await db.query(
    `UPDATE products SET active = false WHERE supplier_id = $1 AND NOT (supplier_sku = ANY($2::text[]))`,
    [adapter.id, products.map((p) => p.supplierSku)],
  );
  return products.length;
}
