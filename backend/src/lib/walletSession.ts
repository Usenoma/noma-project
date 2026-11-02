import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

/**
 * A wallet session is a short-lived, read-only bearer token issued after the buyer proves
 * control of an address with the same message used by the order endpoints. It is stateless
 * (HMAC-signed), scoped to order reads in the route layer, and never used for writes.
 */
const PREFIX = "noma_ws_";
const TTL_MS = config.WALLET_SESSION_TTL_MINUTES * 60_000;

// Key separation: never use the raw encryption key as the MAC key.
const SECRET = createHash("sha256")
  .update(`noma-wallet-session:v1:${config.ENCRYPTION_KEY}`)
  .digest();

interface SessionPayload {
  v: 1;
  a: string;
  e: number;
}

export interface WalletSession {
  token: string;
  address: string;
  expires_at: string;
}

const mac = (payload: string) => createHmac("sha256", SECRET).update(payload).digest("base64url");

export function issueWalletSession(address: string, now = Date.now()): WalletSession {
  const a = address.toLowerCase();
  const e = now + TTL_MS;
  const payload = Buffer.from(
    JSON.stringify({ v: 1, a, e } satisfies SessionPayload),
    "utf8",
  ).toString("base64url");
  return {
    token: `${PREFIX}${payload}.${mac(payload)}`,
    address: a,
    expires_at: new Date(e).toISOString(),
  };
}

/** Returns the lowercased address for a valid, unexpired token; null otherwise. */
export function verifyWalletSession(token: string | undefined, now = Date.now()): string | null {
  if (!token?.startsWith(PREFIX)) return null;
  const body = token.slice(PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0 || dot === body.length - 1) return null;
  const payload = body.slice(0, dot);
  const supplied = Buffer.from(body.slice(dot + 1), "base64url");
  const expected = Buffer.from(mac(payload), "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<SessionPayload>;
    if (parsed.v !== 1) return null;
    if (typeof parsed.a !== "string" || !/^0x[0-9a-f]{40}$/.test(parsed.a)) return null;
    if (typeof parsed.e !== "number" || parsed.e <= now) return null;
    return parsed.a;
  } catch {
    return null;
  }
}

export const walletSessionTtlSeconds = Math.floor(TTL_MS / 1000);
