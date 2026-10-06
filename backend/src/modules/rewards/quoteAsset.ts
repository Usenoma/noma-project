import { zeroAddress, type Address } from "viem";
import { config } from "../../config.js";
import { chain } from "../../chain/client.js";
import { erc20Abi } from "../../chain/abis/index.js";
import { usdPrice } from "../payments/assets.js";

/** The asset $NOMA trades against on Pons: native ETH, or an ERC-20 pair token given by address. */
export const isEthQuote = () => config.NOMA_QUOTE_ASSET === "ETH";
export const quoteToken = (): Address => (isEthQuote() ? zeroAddress : (config.NOMA_QUOTE_ASSET as Address));

/** A token's decimals never change: read once per process. */
let pairDecimals: number | undefined;

export async function quoteDecimals(): Promise<number> {
  if (isEthQuote()) return 18;
  pairDecimals ??= await chain().readContract({ address: quoteToken(), abi: erc20Abi, functionName: "decimals" });
  return pairDecimals;
}

/** Only ETH and USDC have a USD price here; any other pair token is left unpriced. */
async function quotePrice(): Promise<number> {
  if (isEthQuote()) return usdPrice("ETH");
  if (config.USDC_ADDRESS && quoteToken().toLowerCase() === config.USDC_ADDRESS.toLowerCase()) return usdPrice("USDC");
  throw new Error(`no USD price for quote asset ${config.NOMA_QUOTE_ASSET}`);
}

/** Decimal amount × USD price, on raw units. */
export function rawToUsd(raw: bigint, decimals: number, price: number): string {
  return ((Number(raw) / 10 ** decimals) * price).toFixed(6);
}

/** USD value of a raw quote-asset amount, or null without a price. */
export async function quoteUsd(raw: bigint): Promise<string | null> {
  try {
    return rawToUsd(raw, await quoteDecimals(), await quotePrice());
  } catch {
    return null;
  }
}
