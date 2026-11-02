import type { FastifyRequest } from "fastify";
import { verifyWalletAuth } from "./walletAuth.js";
import { verifyWalletSession } from "./walletSession.js";

/** Header accessor shared by the routes that accept a Fastify request. */
export const header = (req: FastifyRequest, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * Resolve the wallet that proved control of itself: either a short-lived read-only session from the
 * vault, or a fresh signature over the same message. Returns null when no valid proof is present.
 */
export async function walletFromHeaders(req: FastifyRequest): Promise<string | null> {
  const authorization = header(req, "authorization");
  if (authorization?.startsWith("Bearer noma_ws_")) {
    const address = verifyWalletSession(authorization.slice("Bearer ".length));
    if (address) return address;
  }
  return verifyWalletAuth(
    header(req, "x-wallet-address"),
    header(req, "x-wallet-signature"),
    header(req, "x-wallet-timestamp"),
  );
}
