import type { Address } from "viem";
import { config } from "../../config.js";
import { HttpError } from "../../lib/errors.js";
import { redis } from "../../redis.js";

export { usdToUnits } from "./units.js";

export type PayAsset = "USDG" | "ETH";

export interface AssetInfo {
  symbol: PayAsset;
  decimals: number;
  token: Address | null; // null = native
}

export function assetInfo(symbol: PayAsset): AssetInfo {
  switch (symbol) {
    case "USDG":
      if (!config.USDG_ADDRESS) throw new Error("USDG_ADDRESS not configured");
      return { symbol, decimals: 6, token: config.USDG_ADDRESS as Address };
    case "ETH":
      return { symbol, decimals: 18, token: null };
    default:
      // legacy rows can still carry an old symbol (e.g. USDC from before the USDG rename)
      throw new Error(`unsupported payment asset: ${symbol}`);
  }
}

/**
 * USD price of a pay asset. Stablecoins are pegged at 1.
 * ETH price is read from Redis (`price:ETH`), written by the price-feed worker (priceFeed.ts).
 */
export async function usdPrice(symbol: PayAsset): Promise<number> {
  if (symbol === "USDG") return 1;
  if (symbol !== "ETH") throw new Error(`unsupported payment asset: ${symbol}`);
  const cached = await redis.get(`price:${symbol}`);
  if (!cached) throw new HttpError(503, `${symbol} payments temporarily unavailable (no price)`);
  return Number(cached);
}
