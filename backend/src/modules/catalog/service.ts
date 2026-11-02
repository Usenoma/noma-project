import { db, getSetting } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
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
  available: boolean;
}

const PUBLIC_COLUMNS =
  "p.id, p.supplier_id, p.category, p.title, p.region, p.specs, p.price_usd, p.required_fields";

export interface CatalogQuery {
  category?: Category;
  region?: string;
  q?: string;
  sort?: "price_asc" | "price_desc" | "title";
  maxPrice?: number;
  specs?: Record<string, number>; // minimum numeric spec values, e.g. { data_gb: 20 }
  limit?: number;
  offset?: number;
}

const SORTS = {
  price_asc: "price_usd ASC",
  price_desc: "price_usd DESC",
  title: "title ASC",
} as const;

function buildWhere(query: CatalogQuery): { clause: string; params: unknown[] } {
  // VPN and proxy are retired from the marketplace; the filter lives here so no query path
  // (catalog, facets, orders, the agent, capsules) can see or sell them again.
  const where = ["p.active", "p.category NOT IN ('vpn', 'proxy')"];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };

  if (query.category) add("p.category = ?", query.category);
  if (query.region) {
    params.push(query.region.toUpperCase());
    where.push(`(upper(p.region) = $${params.length} OR p.specs -> 'countries' ? $${params.length})`);
  }
  if (query.q) add("to_tsvector('simple', p.title) @@ plainto_tsquery('simple', ?)", query.q);
  if (query.maxPrice !== undefined) add("p.price_usd <= ?", query.maxPrice);
  for (const [key, min] of Object.entries(query.specs ?? {})) {
    if (!/^[a-z0-9_]+$/.test(key)) continue;
    add(`(p.specs->>'${key}')::numeric >= ?`, min);
  }
  return { clause: where.join(" AND "), params };
}

export async function listProducts(query: CatalogQuery): Promise<Product[]> {
  const { clause, params } = buildWhere(query);
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);
  params.push(limit, offset);
  const { rows } = await db.query<Product>(
    `SELECT ${PUBLIC_COLUMNS},
            (s.balance_usd IS NULL OR s.balance_usd >= p.cost_usd) AS available
     FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE ${clause}
     ORDER BY ${SORTS[query.sort ?? "price_asc"]} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows;
}

export async function countProducts(query: CatalogQuery): Promise<number> {
  const { clause, params } = buildWhere(query);
  const { rows } = await db.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM products p WHERE ${clause}`,
    params,
  );
  return Number(rows[0]?.total ?? 0);
}

/** Region counts for the current filter set (the caller leaves out the region filter). */
export async function regionFacets(query: CatalogQuery): Promise<{ region: string; count: number }[]> {
  const { clause, params } = buildWhere(query);
  const { rows } = await db.query<{ region: string; count: string }>(
    `SELECT p.region, count(*)::text AS count FROM products p
     WHERE ${clause} AND p.region IS NOT NULL AND p.region <> ''
     GROUP BY p.region ORDER BY p.region`,
    params,
  );
  return rows.map((r) => ({ region: r.region, count: Number(r.count) }));
}

export async function getProduct(id: string): Promise<Product | undefined> {
  const { rows } = await db.query<Product>(
    `SELECT ${PUBLIC_COLUMNS}, (s.balance_usd IS NULL OR s.balance_usd >= p.cost_usd) AS available
     FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE p.id = $1 AND p.active AND p.category NOT IN ('vpn', 'proxy')`,
    [id],
  );
  return rows[0];
}

export async function getProducts(ids: string[]): Promise<Product[]> {
  const { rows } = await db.query<Product>(
    `SELECT ${PUBLIC_COLUMNS}, (s.balance_usd IS NULL OR s.balance_usd >= p.cost_usd) AS available
     FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE p.id = ANY($1::uuid[]) AND p.active AND p.category NOT IN ('vpn', 'proxy')`,
    [ids],
  );
  return rows;
}

/** Upsert a supplier's normalized catalog and deactivate SKUs the supplier no longer lists. */
export async function syncSupplierCatalog(adapter: SupplierAdapter, listed: NormalizedProduct[]): Promise<number> {
  // a SKU listed twice (overlapping API pages, repeated packages) would make the batched upsert
  // touch the same row twice, which Postgres rejects for the whole chunk: keep the first listing
  const bySku = new Map<string, NormalizedProduct>();
  for (const p of listed) if (!bySku.has(p.supplierSku)) bySku.set(p.supplierSku, p);
  const products = [...bySku.values()];
  if (products.length < listed.length) {
    logger.warn({ supplier: adapter.id, duplicates: listed.length - products.length }, "duplicate SKUs in supplier catalog ignored");
  }
  const markup = (await getSetting<MarkupConfig>("markup_pct")) ?? { default: 0.08 };
  await db.query(
    `INSERT INTO suppliers (id, name, category) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
    [adapter.id, adapter.name, adapter.category],
  );

  // batched upsert: some suppliers list thousands of SKUs
  for (let i = 0; i < products.length; i += 500) {
    const chunk = products.slice(i, i + 500);
    await db.query(
      `INSERT INTO products (supplier_id, supplier_sku, category, title, region, specs, cost_usd, price_usd, required_fields, synced_at)
       SELECT $1, sku, category, title, region, specs, cost, price, fields, now()
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::jsonb[], $7::numeric[], $8::numeric[], $9::jsonb[])
         AS t(sku, category, title, region, specs, cost, price, fields)
       ON CONFLICT (supplier_id, supplier_sku) DO UPDATE SET
         title = EXCLUDED.title, region = EXCLUDED.region, specs = EXCLUDED.specs,
         cost_usd = EXCLUDED.cost_usd, price_usd = EXCLUDED.price_usd,
         required_fields = EXCLUDED.required_fields, synced_at = now()`,
      [
        adapter.id,
        chunk.map((p) => p.supplierSku),
        chunk.map((p) => p.category),
        chunk.map((p) => p.title),
        chunk.map((p) => p.region),
        chunk.map((p) => JSON.stringify(p.specs)),
        chunk.map((p) => p.costUsd),
        chunk.map((p) => applyMarkup(p.costUsd, p.category, markup)),
        chunk.map((p) => JSON.stringify(p.requiredFields)),
      ],
    );
  }

  await db.query(
    `UPDATE products SET active = false WHERE supplier_id = $1 AND NOT (supplier_sku = ANY($2::text[]))`,
    [adapter.id, products.map((p) => p.supplierSku)],
  );
  return products.length;
}
