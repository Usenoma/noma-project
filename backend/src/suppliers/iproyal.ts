import { createHmac } from "node:crypto";
import type { NormalizedProduct, SupplierAdapter, SupplierStatus } from "./types.js";

const RESI = "https://resi-api.iproyal.com/v1";
const RESELLER = "https://apid.iproyal.com/v1/reseller";
/** Residential gateway (docs: "geo.iproyal.com" recommended); standard ports. */
const GATEWAY = { host: "geo.iproyal.com", http: 12321, socks5: 32325 } as const;
/** Traffic packages offered to customers (GB). */
export const RESIDENTIAL_PACKAGES_GB = [1, 5, 10, 25] as const;

interface SubUser {
  id: number;
  hash: string;
  username: string;
  traffic_available: number;
  traffic_used?: number;
}
interface Page<T> {
  data: T[];
}

/**
 * IPRoyal residential proxies, sold as traffic packages. Each order becomes an IPRoyal sub-user
 * holding exactly the purchased GB, so customers never share traffic. Main-account traffic is
 * bought only when the account holds too little, which also makes a retried purchase safe: the
 * API has no idempotency key, and the sub-user username (derived from the order id) is the dedup
 * key. The sub-user password is derived from the order id, so it is never stored.
 */
export function createIpRoyalAdapter(apiToken: string, passwordSecret: Buffer): SupplierAdapter {
  async function call<T>(base: string, method: string, path: string, body?: unknown): Promise<T> {
    const auth: Record<string, string> = base === RESI ? { Authorization: `Bearer ${apiToken}` } : { "X-Access-Token": apiToken };
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...auth, Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`iproyal ${method} ${path} ${res.status}: ${text}`), { status: res.status });
    return (text ? JSON.parse(text) : {}) as T;
  }
  const resi = <T>(method: string, path: string, body?: unknown) => call<T>(RESI, method, path, body);

  const username = (orderId: string) => `noma${orderId.replace(/-/g, "").slice(0, 20)}`;
  const password = (orderId: string) =>
    `Nm${createHmac("sha256", passwordSecret).update(`iproyal:${orderId}`).digest("base64url").slice(0, 20)}`;

  const priceFor = async (gb: number) =>
    (await resi<{ total: number }>("GET", `/residential/orders/calculate-pricing?quantity=${gb}`)).total;
  const gbFromSku = (sku: string) => {
    const gb = Number(/^resi-(\d+)gb$/.exec(sku)?.[1]);
    if (!RESIDENTIAL_PACKAGES_GB.includes(gb as (typeof RESIDENTIAL_PACKAGES_GB)[number])) throw new Error(`unknown IPRoyal sku ${sku}`);
    return gb;
  };

  async function findSubUser(name: string): Promise<SubUser | undefined> {
    const res = await resi<Page<SubUser>>("GET", `/residential-subusers?search=${encodeURIComponent(name)}&per_page=50`);
    return res.data.find((s) => s.username === name);
  }

  // supplierOrderId = "<subuser hash>|<orderId>"
  const parseRef = (ref: string) => {
    const [hash, orderId] = ref.split("|");
    return { hash: hash!, orderId: orderId! };
  };

  return {
    id: "iproyal",
    name: "IPRoyal",
    category: "proxy",
    catalogTtlMinutes: 6 * 60,

    async syncCatalog() {
      const products: NormalizedProduct[] = [];
      for (const gb of RESIDENTIAL_PACKAGES_GB) {
        products.push({
          supplierSku: `resi-${gb}gb`,
          category: "proxy",
          title: `Residential proxies, ${gb} GB traffic (worldwide, rotating or sticky)`,
          region: null,
          specs: { proxy_type: "residential", traffic_gb: gb, protocols: ["HTTP", "HTTPS", "SOCKS5"], targeting: "country" },
          costUsd: await priceFor(gb),
          requiredFields: [],
        });
      }
      return products;
    },

    async quote(sku) {
      return { costUsd: await priceFor(gbFromSku(sku)) };
    },

    async purchase(sku, _fields, orderId) {
      const gb = gbFromSku(sku);
      const existing = await findSubUser(username(orderId));
      if (existing) return { supplierOrderId: `${existing.hash}|${orderId}` };

      const me = await resi<{ available_traffic: number }>("GET", "/residential/me");
      if (me.available_traffic < gb) {
        // one-off purchase from the prepaid balance (the API defaults to a recurring subscription)
        await resi("POST", "/residential/orders", { quantity: Math.ceil(gb - me.available_traffic), order_billing_type: "regular" });
      }
      const sub = await resi<SubUser>("POST", "/residential-subusers", {
        username: username(orderId),
        password: password(orderId),
        traffic: gb,
      });
      return { supplierOrderId: `${sub.hash}|${orderId}` };
    },

    async status(ref): Promise<SupplierStatus> {
      const { hash } = parseRef(ref);
      const sub = await resi<SubUser>("GET", `/residential-subusers/${hash}`);
      return sub.traffic_available > 0 ? "done" : "pending";
    },

    async deliverable(ref) {
      const { hash, orderId } = parseRef(ref);
      const sub = await resi<SubUser>("GET", `/residential-subusers/${hash}`);
      const user = username(orderId);
      const pass = password(orderId);
      return {
        type: "proxy_credentials",
        payload: {
          host: GATEWAY.host,
          ports: { http: GATEWAY.http, socks5: GATEWAY.socks5 },
          username: user,
          password: pass,
          traffic_gb: sub.traffic_available,
          examples: {
            http: `http://${user}:${pass}@${GATEWAY.host}:${GATEWAY.http}`,
            socks5: `socks5://${user}:${pass}@${GATEWAY.host}:${GATEWAY.socks5}`,
            country: `http://${user}:${pass}_country-us@${GATEWAY.host}:${GATEWAY.http}`,
            sticky_session: `http://${user}:${pass}_session-abc12345_lifetime-30m@${GATEWAY.host}:${GATEWAY.http}`,
          },
          note: "Targeting and session options are appended to the password (e.g. _country-de, _session-<id>_lifetime-30m). Traffic is used up as you browse.",
        },
      };
    },

    /** Prepaid balance on the reseller API (same dashboard token; null if that API refuses it). */
    async balance() {
      try {
        return Number(await call<number>(RESELLER, "GET", "/balance"));
      } catch (err) {
        if ([401, 403].includes((err as { status?: number }).status ?? 0)) return null;
        throw err;
      }
    },
  };
}
