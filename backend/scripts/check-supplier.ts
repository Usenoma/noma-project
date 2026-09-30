/**
 * Read-only credential check for a supplier adapter: balance + catalog size. Never purchases.
 * Usage: npx tsx --env-file=.env scripts/check-supplier.ts <supplier-id> [region]
 */
import { adapter } from "../src/suppliers/registry.js";

const [id, region] = process.argv.slice(2);
if (!id) {
  console.error("usage: check-supplier.ts <supplier-id> [region]");
  process.exit(2);
}

try {
  const a = adapter(id);
  const balance = await a.balance();
  console.log(`${a.name}: balance ${balance === null ? "not exposed by the API" : `$${balance.toFixed(2)}`}`);
  const products = await a.syncCatalog();
  const inRegion = region ? products.filter((p) => p.region === region.toUpperCase()) : products;
  console.log(`products: ${products.length}${region ? ` | in ${region.toUpperCase()}: ${inRegion.length}` : ""}`);
  for (const p of inRegion.sort((x, y) => x.costUsd - y.costUsd).slice(0, 5)) {
    console.log(`  ${p.title} | cost $${p.costUsd.toFixed(2)}`);
  }
  process.exit(0);
} catch (err) {
  console.error("FAILED:", (err as Error).message);
  process.exit(1);
}
