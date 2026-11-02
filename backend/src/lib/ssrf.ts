import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guard for the Ghost Agent's page fetches. Every URL (and every redirect hop) must be
 * http(s) and must resolve only to public IPs. DNS is resolved fresh per call — no cache.
 */

const privateIpv4 = (ip: string): boolean => {
  const parts = ip.split(".").map(Number);
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 192 && b === 0) return true; // 192.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
};

const privateIpv6 = (ip: string): boolean => {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 ULA
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  return false;
};

/** Unknown/unsupported addresses are treated as unsafe (fail closed). */
export function isPrivateIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return privateIpv4(ip);
  if (family === 6) return privateIpv6(ip);
  return true;
}

export async function resolveSafeHost(host: string): Promise<void> {
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((a) => isPrivateIp(a.address))) {
    throw new Error(`refusing to fetch ${host}: resolves to a non-public address`);
  }
}

export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http(s) URLs are allowed");
  }
  await resolveSafeHost(url.hostname);
  return url;
}
