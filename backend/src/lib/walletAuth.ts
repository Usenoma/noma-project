import { isAddress, verifyMessage, type Address, type Hex } from "viem";

const MAX_SKEW_MS = 5 * 60 * 1000;

/** The exact message a wallet signs to list its own orders. Never used for anything that moves funds. */
export function walletAuthMessage(address: string, timestamp: number): string {
  return `NOMA: view my orders\naddress: ${address.toLowerCase()}\ntimestamp: ${timestamp}`;
}

export async function verifyWalletAuth(
  address: string | undefined,
  signature: string | undefined,
  timestamp: string | undefined,
  now = Date.now(),
): Promise<Address | null> {
  if (!address || !signature || !timestamp || !isAddress(address)) return null;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) return null;
  const ok = await verifyMessage({
    address,
    message: walletAuthMessage(address, ts),
    signature: signature as Hex,
  }).catch(() => false);
  return ok ? address : null;
}
