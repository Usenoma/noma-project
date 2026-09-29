import { logger } from "../../lib/logger.js";
import { redis } from "../../redis.js";

/** Price key expires quickly: a stale feed must disable ETH checkout rather than misprice it. */
export const PRICE_TTL_SECONDS = 120;
const MAX_SOURCE_DIVERGENCE = 0.02;

type Source = { name: string; fetch: () => Promise<number> };

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

const SOURCES: Source[] = [
  {
    name: "coinbase",
    fetch: async () => {
      const body = (await getJson("https://api.coinbase.com/v2/prices/ETH-USD/spot")) as { data: { amount: string } };
      return Number(body.data.amount);
    },
  },
  {
    name: "kraken",
    fetch: async () => {
      const body = (await getJson("https://api.kraken.com/0/public/Ticker?pair=ETHUSD")) as {
        result: Record<string, { c: [string, string] }>;
      };
      const ticker = Object.values(body.result)[0];
      if (!ticker) throw new Error("kraken: empty result");
      return Number(ticker.c[0]);
    },
  },
];

/**
 * Combine quotes from independent sources. Needs at least two agreeing sources:
 * a single source (or two that disagree by more than 2%) is not trusted to price invoices.
 */
export function combineQuotes(quotes: number[]): number | null {
  const valid = quotes.filter((q) => Number.isFinite(q) && q > 0).sort((a, b) => a - b);
  if (valid.length < 2) return null;
  const lo = valid[0]!;
  const hi = valid[valid.length - 1]!;
  if ((hi - lo) / lo > MAX_SOURCE_DIVERGENCE) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[mid]! : (valid[mid - 1]! + valid[mid]!) / 2;
}

export async function refreshEthPrice(): Promise<void> {
  const results = await Promise.allSettled(SOURCES.map((s) => s.fetch()));
  const quotes = results.flatMap((r, i) => {
    if (r.status === "fulfilled") return [r.value];
    logger.warn({ source: SOURCES[i]!.name, err: String(r.reason) }, "price source failed");
    return [];
  });
  const price = combineQuotes(quotes);
  if (price === null) {
    logger.error({ quotes }, "ALERT ETH price unavailable or sources diverge; ETH checkout disabled until recovered");
    return;
  }
  await redis.set("price:ETH", price.toFixed(2), "EX", PRICE_TTL_SECONDS);
}
