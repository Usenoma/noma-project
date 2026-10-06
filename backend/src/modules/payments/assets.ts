import type { Address } from "viem";
import { config } from "../../config.js";
import { HttpError } from "../../lib/errors.js";
import { redis } from "../../redis.js";

export { usdToUnits } from "./units.js";

export type PayAsset = "USDC" | "ETH";

export interface AssetInfo {
  symbol: PayAsset;
  decimals: number;
  token: Address | null; // null = native
}

export function assetInfo(symbol: PayAsset): AssetInfo {
  switch (symbol) {
    case "USDC":
      if (!config.USDC_ADDRESS) throw new Error("USDC_ADDRESS not configured");
      return { symbol, decimals: 6, token: config.USDC_ADDRESS as Address };
    case "ETH":
      return { symbol, decimals: 18, token: null };
  }
}

/**
 * USD price of a pay asset. Stablecoins are pegged at 1.
 * ETH price is read from Redis (`price:ETH`), written by the price-feed worker (priceFeed.ts).
 */
export async function usdPrice(symbol: PayAsset): Promise<number> {
  if (symbol === "USDC") return 1;
  const cached = await redis.get(`price:${symbol}`);
  if (!cached) throw new HttpError(503, `${symbol} payments temporarily unavailable (no price)`);
  return Number(cached);
}
