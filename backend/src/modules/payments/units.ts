/** Convert a USD amount to raw units of the asset, rounding up so the invoice is never under-priced. */
export function usdToUnits(usd: number, price: number, decimals: number): bigint {
  // work in micro-USD to avoid float drift on the multiplication
  const microUsd = BigInt(Math.round(usd * 1e6));
  const microPrice = BigInt(Math.round(price * 1e6));
  const scale = 10n ** BigInt(decimals);
  return (microUsd * scale + microPrice - 1n) / microPrice;
}
