import { createHmac } from "node:crypto";
import type { NormalizedProduct, RequiredField, SupplierAdapter, SupplierStatus } from "./types.js";

const BASE = "https://app.bitlaunch.io/api";
/** BitLaunch's own host id (0 DigitalOcean, 1 Vultr, 2 Linode, 4 BitLaunch). */
const HOST_ID = 4;
/** VPS products are sold as fixed-length rentals; the expiry job destroys the server afterwards. */
export const VPS_LIFETIME_DAYS = 30;
/** Only offer mainstream Linux images; Windows carries undocumented extra licence cost. */
const IMAGE_ALLOWLIST = /^(ubuntu|debian|rocky|alma|fedora)/i;
const MAX_VERSIONS_PER_OS = 3;

interface ImageVersion {
  id: string;
  description: string;
  passwordUnsupported?: boolean;
}
interface HostImage {
  id: number;
  name: string;
  type: string;
  windows?: boolean;
  version?: ImageVersion;
  versions?: ImageVersion[];
  unavailableRegions?: string[];
}
interface Subregion {
  id: string;
  slug?: string;
  description: string;
  unavailableSizes?: string[];
}
interface HostRegion {
  id: number;
  name: string;
  iso: string;
  subregion?: Subregion;
  subregions?: Subregion[];
}
interface HostSize {
  id: string;
  cpuCount: number;
  memoryMB: number;
  diskGB: number;
  bandwidthGB: number;
  costPerMonth: number; // whole USD
}
interface CreateOptions {
  available: boolean;
  image: HostImage[];
  region: HostRegion[];
  size: HostSize[];
}
interface Server {
  id: string;
  name: string;
  status: string;
  ipv4: string;
  errorText?: string;
  region?: string;
  size?: string;
}

/**
 * BitLaunch VPS (prepaid balance, billed hourly, capped at the monthly price).
 * The API has no idempotency key, so the server name `noma-<orderId>` is the dedup key:
 * a retried purchase looks the name up before creating.
 */
export function createBitLaunchAdapter(apiToken: string, passwordSecret: Buffer): SupplierAdapter {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`bitlaunch ${method} ${path} ${res.status}: ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Root password derived from the order id: recoverable at delivery time without storing it anywhere. */
  const rootPassword = (orderId: string) =>
    `Nm${createHmac("sha256", passwordSecret).update(`bitlaunch-root:${orderId}`).digest("base64url").slice(0, 22)}9!`;

  const serverName = (orderId: string) => `noma-${orderId}`;
  const getServer = async (id: string) => (await call<{ server: Server }>("GET", `/servers/${id}`)).server;
  const imageVersions = (img: HostImage) => img.versions ?? (img.version ? [img.version] : []);

  return {
    id: "bitlaunch",
    name: "BitLaunch",
    category: "vps",

    async syncCatalog() {
      const opts = await call<CreateOptions>("GET", `/hosts-create-options/${HOST_ID}`);
      if (!opts.available) return [];

      const images = opts.image.filter((i) => !i.windows && i.type === "image" && IMAGE_ALLOWLIST.test(i.name));
      const products: NormalizedProduct[] = [];

      for (const region of opts.region) {
        const subs = region.subregions ?? (region.subregion ? [region.subregion] : []);
        for (const sub of subs) {
          // subregion "description" is just an index ("1", "3"); the city is region.name
          const location = subs.length > 1 ? `${region.name} (${sub.slug ?? sub.id})` : region.name;
          const osOptions = images
            .filter((i) => !i.unavailableRegions?.includes(sub.id))
            // versions are listed newest first; older ones are mostly end-of-life
            .flatMap((i) => imageVersions(i).filter((v) => !v.passwordUnsupported).slice(0, MAX_VERSIONS_PER_OS).map((v) => ({ value: v.id, label: v.description })));
          if (!osOptions.length) continue;
          const osField: RequiredField = { name: "os", label: "Operating system", type: "select", options: osOptions };

          for (const size of opts.size) {
            if (sub.unavailableSizes?.includes(size.id)) continue;
            const ramGb = Math.round((size.memoryMB / 1024) * 10) / 10;
            products.push({
              supplierSku: `${sub.id}|${size.id}`,
              category: "vps",
              title: `VPS ${size.cpuCount} vCPU / ${ramGb} GB RAM / ${size.diskGB} GB SSD, ${location} (${VPS_LIFETIME_DAYS} days)`,
              region: region.iso?.toUpperCase() || null,
              specs: {
                cpu: size.cpuCount,
                ram_gb: ramGb,
                disk_gb: size.diskGB,
                bandwidth_gb: size.bandwidthGB || null, // 0 = not metered
                location,
                duration_days: VPS_LIFETIME_DAYS,
              },
              costUsd: size.costPerMonth,
              requiredFields: [osField],
            });
          }
        }
      }
      return products;
    },

    async quote(sku) {
      const [, sizeId] = sku.split("|");
      const opts = await call<CreateOptions>("GET", `/hosts-create-options/${HOST_ID}`);
      const size = opts.size.find((s) => s.id === sizeId);
      if (!size) throw new Error(`bitlaunch size ${sizeId} not found`);
      return { costUsd: size.costPerMonth };
    },

    async purchase(sku, fields, orderId) {
      const existing = (await call<Server[]>("GET", "/servers")).find((s) => s.name === serverName(orderId));
      if (existing) return { supplierOrderId: existing.id };

      const [regionId, sizeId] = sku.split("|");
      if (!fields.os) throw new Error("os field missing");
      const created = await call<Server>("POST", "/servers", {
        server: {
          name: serverName(orderId),
          hostID: HOST_ID,
          hostImageID: fields.os,
          sizeID: sizeId,
          regionID: regionId,
          password: rootPassword(orderId),
        },
      });
      return { supplierOrderId: created.id };
    },

    async status(serverId): Promise<SupplierStatus> {
      const s = await getServer(serverId);
      if (s.status === "error") return "failed";
      return s.status === "ok" && s.ipv4 ? "done" : "pending";
    },

    async deliverable(serverId) {
      const s = await getServer(serverId);
      const orderId = s.name.replace(/^noma-/, "");
      return {
        type: "vps_credentials",
        payload: {
          ipv4: s.ipv4,
          username: "root",
          password: rootPassword(orderId),
          ssh: `ssh root@${s.ipv4}`,
          expires_in_days: VPS_LIFETIME_DAYS,
          note: "Change the root password after first login. The server is deleted when the rental period ends.",
        },
      };
    },

    async release(serverId) {
      await call("DELETE", `/servers/${serverId}`);
    },

    async balance() {
      const user = await call<{ balance: number }>("GET", "/user");
      return user.balance / 1000; // USD x 1000
    },
  };
}
