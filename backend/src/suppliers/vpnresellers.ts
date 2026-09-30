import { createHmac } from "node:crypto";
import type { NormalizedProduct, RequiredField, SupplierAdapter, SupplierStatus } from "./types.js";

const BASE = "https://api.vpnresellers.com/v3_2";
/** Sold as fixed-length rentals; the expiry job deletes the account, which stops the daily charge. */
export const VPN_DURATIONS_DAYS = [30, 90, 180] as const;

interface Account {
  id: number;
  username: string;
  status: "Active" | "Disabled";
  expired_at: string | null;
}
interface Server {
  id: number;
  name: string;
  ip: string;
  country_code: string;
  city: string;
}
interface ConfigFile {
  file_body: string;
  file_name: string;
}
interface Page<T> {
  data: T[];
  links?: { next: string | null };
}

export interface VpnResellersOptions {
  /** Per active account per month (pricing page, 1–999 accounts tier). No price-list endpoint exists. */
  monthlyUsd: number;
}

/**
 * VPNresellers (API v3.2). One account works on every server; the customer picks the server the
 * config files are generated for. The API has no idempotency key: the username is derived from the
 * order id (globally unique there) and a retried create that hits "taken" looks the account up.
 * The password is derived from the order id too, so it is never stored.
 */
export function createVpnResellersAdapter(apiToken: string, passwordSecret: Buffer, opts: VpnResellersOptions): SupplierAdapter {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`vpnresellers ${method} ${path} ${res.status}: ${text}`), { status: res.status });
    return (text ? JSON.parse(text) : {}) as T;
  }

  const username = (orderId: string) => `noma${orderId.replace(/-/g, "").slice(0, 24)}`;
  const password = (orderId: string) =>
    `Nm${createHmac("sha256", passwordSecret).update(`vpnresellers:${orderId}`).digest("base64url").slice(0, 20)}`;

  const servers = async () => (await call<{ data: Server[] }>("GET", "/servers")).data;
  const costFor = (days: number) => Math.round(opts.monthlyUsd * (days / 30) * 100) / 100;

  async function findByUsername(name: string): Promise<Account | undefined> {
    for (let page = 1; page <= 200; page++) {
      const res = await call<Page<Account>>("GET", `/accounts?page=${page}&per_page=100`);
      const hit = res.data.find((a) => a.username === name);
      if (hit) return hit;
      if (!res.links?.next || res.data.length === 0) return undefined;
    }
    return undefined;
  }

  // supplierOrderId = "<accountId>|<serverId>|<orderId>": everything delivery needs, nothing secret
  const parseRef = (ref: string) => {
    const [accountId, serverId, orderId] = ref.split("|");
    return { accountId: accountId!, serverId: serverId!, orderId: orderId! };
  };

  return {
    id: "vpnresellers",
    name: "VPNresellers",
    category: "vpn",
    catalogTtlMinutes: 60,

    async syncCatalog() {
      const list = await servers();
      if (!list.length) return [];
      const countries = [...new Set(list.map((s) => s.country_code.toUpperCase()))].sort();
      const serverField: RequiredField = {
        name: "server",
        label: "Server location (the account works on every server; config files are made for this one)",
        type: "select",
        options: list
          .slice()
          .sort((a, b) => a.country_code.localeCompare(b.country_code) || a.city.localeCompare(b.city))
          .map((s) => ({ value: String(s.id), label: `${s.city}, ${s.country_code.toUpperCase()}` })),
      };
      return VPN_DURATIONS_DAYS.map(
        (days): NormalizedProduct => ({
          supplierSku: `vpn-${days}d`,
          category: "vpn",
          title: `VPN, ${countries.length} countries, ${list.length} servers (${days} days)`,
          region: null,
          specs: {
            countries,
            servers: list.length,
            protocols: ["OpenVPN", "WireGuard"],
            devices: 1,
            duration_days: days,
          },
          costUsd: costFor(days),
          requiredFields: [serverField],
        }),
      );
    },

    async quote(sku) {
      const days = Number(/^vpn-(\d+)d$/.exec(sku)?.[1]);
      if (!VPN_DURATIONS_DAYS.includes(days as (typeof VPN_DURATIONS_DAYS)[number])) throw new Error(`unknown VPN sku ${sku}`);
      return { costUsd: costFor(days) };
    },

    async purchase(sku, fields, orderId) {
      const days = Number(/^vpn-(\d+)d$/.exec(sku)?.[1]);
      if (!days) throw new Error(`unknown VPN sku ${sku}`);
      const serverId = Number(fields.server);
      if (!(await servers()).some((s) => s.id === serverId)) throw new Error(`VPN server ${fields.server} not available`);

      let account: Account | undefined;
      try {
        account = (await call<{ data: Account }>("POST", "/accounts", { username: username(orderId), password: password(orderId) })).data;
      } catch (err) {
        // a retried purchase: the account was created on an earlier attempt
        if ((err as { status?: number }).status !== 422) throw err;
        account = await findByUsername(username(orderId));
        if (!account) throw err;
      }
      // safety net next to the expiry job: the account also stops at the supplier (+1 day grace)
      const expireAt = new Date(Date.now() + (days + 1) * 86_400_000).toISOString().slice(0, 10);
      await call("PUT", `/accounts/${account.id}/expire`, { expire_at: expireAt });
      return { supplierOrderId: `${account.id}|${serverId}|${orderId}` };
    },

    async status(ref): Promise<SupplierStatus> {
      const { accountId } = parseRef(ref);
      const a = (await call<{ data: Account }>("GET", `/accounts/${accountId}`)).data;
      return a.status === "Active" ? "done" : "failed";
    },

    async deliverable(ref) {
      const { accountId, serverId, orderId } = parseRef(ref);
      const [server, openvpn, wireguard] = await Promise.all([
        servers().then((l) => l.find((s) => String(s.id) === serverId)),
        call<{ data: ConfigFile }>("GET", `/configuration?server_id=${serverId}`),
        call<{ data: ConfigFile }>("GET", `/accounts/${accountId}/wireguard-configuration?server_id=${serverId}`),
      ]);
      return {
        type: "vpn_config",
        payload: {
          username: username(orderId),
          password: password(orderId),
          server: server ? `${server.city}, ${server.country_code.toUpperCase()} (${server.name})` : serverId,
          openvpn: { file_name: openvpn.data.file_name, file_body: openvpn.data.file_body },
          wireguard: { file_name: wireguard.data.file_name, file_body: wireguard.data.file_body },
          note: "OpenVPN: import the .ovpn file and sign in with the username and password. WireGuard: import the .conf file. The account ends when the rental period ends.",
        },
      };
    },

    async release(ref) {
      const { accountId } = parseRef(ref);
      try {
        await call("DELETE", `/accounts/${accountId}`);
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err; // already gone
      }
    },

    // the API exposes no balance; a 402 on account creation is its only low-balance signal
    async balance() {
      return null;
    },
  };
}
