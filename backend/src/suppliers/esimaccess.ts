import { createHmac, randomUUID } from "node:crypto";
import type { NormalizedProduct, SupplierAdapter, SupplierStatus } from "./types.js";

const BASE = "https://api.esimaccess.com/api/v1/open";
/** eSIM Access money fields are integers in 1/10,000 USD. */
const MONEY_UNIT = 10_000;
const GIB = 1024 ** 3;

/** Allocation is async (~30 s); this error code means "not ready yet". */
const ERR_ALLOCATING = "200010";

interface Envelope<T> {
  success: boolean;
  errorCode: string | null;
  errorMessage?: string;
  errorMsg?: string;
  obj: T;
}

interface Package {
  packageCode: string;
  slug: string;
  name: string;
  price: number;
  volume: number;
  duration: number;
  durationUnit: string;
  location: string;
  dataType: number;
  speed?: string;
  smsStatus?: number;
  activeType?: number;
}

interface Esim {
  esimTranNo: string;
  orderNo: string;
  iccid: string;
  ac: string;
  qrCodeUrl?: string;
  shortUrl?: string;
  esimStatus: string;
  apn?: string;
  pin?: string;
  puk?: string;
  expiredTime?: string;
}

export class EsimAccessError extends Error {
  constructor(
    readonly code: string | null,
    message: string,
  ) {
    super(`esimaccess ${code}: ${message}`);
  }
}

/** HMAC-SHA256 over timestamp + requestId + accessCode + raw body, lowercase hex (per docs). */
export function esimAccessSignature(timestamp: string, requestId: string, accessCode: string, body: string, secret: string): string {
  return createHmac("sha256", secret).update(timestamp + requestId + accessCode + body).digest("hex");
}

const DONE = new Set(["GOT_RESOURCE", "IN_USE", "USED_UP", "USED_EXPIRED", "UNUSED_EXPIRED"]);
const FAILED = new Set(["CANCEL", "REVOKE"]);

/**
 * eSIM Access (prepaid balance). No sandbox exists: test with real, cancellable orders.
 * `transactionId` is the documented idempotency key, so retried purchases return the same order.
 * Credentials: ESIMACCESS_KEY = "<accessCode>:<secretKey>".
 */
export function createEsimAccessAdapter(credentials: string): SupplierAdapter {
  const [accessCode, secret] = credentials.split(":");
  if (!accessCode || !secret) throw new Error("ESIMACCESS_KEY must be '<accessCode>:<secretKey>'");

  async function call<T>(path: string, payload: unknown): Promise<T> {
    const body = JSON.stringify(payload);
    const timestamp = Date.now().toString();
    const requestId = randomUUID();
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "RT-AccessCode": accessCode!,
        "RT-RequestID": requestId,
        "RT-Timestamp": timestamp,
        "RT-Signature": esimAccessSignature(timestamp, requestId, accessCode!, body, secret!),
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`esimaccess ${path} HTTP ${res.status}`);
    const env = (await res.json()) as Envelope<T>;
    if (!env.success) throw new EsimAccessError(env.errorCode, env.errorMessage ?? env.errorMsg ?? "unknown error");
    return env.obj;
  }

  const firstEsim = async (orderNo: string): Promise<Esim | null> => {
    try {
      const obj = await call<{ esimList: Esim[] }>("/esim/query", { orderNo, pager: { pageNum: 1, pageSize: 5 } });
      return obj.esimList[0] ?? null;
    } catch (err) {
      if (err instanceof EsimAccessError && err.code === ERR_ALLOCATING) return null;
      throw err;
    }
  };

  return {
    id: "esimaccess",
    name: "eSIM Access",
    category: "esim",

    async syncCatalog() {
      const { packageList } = await call<{ packageList: Package[] }>("/package/list", { type: "BASE" });
      return packageList.map((p): NormalizedProduct => {
        const countries = p.location.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
        const days = p.durationUnit === "DAY" ? p.duration : null;
        return {
          supplierSku: p.packageCode,
          category: "esim",
          title: p.name,
          region: countries.length === 1 ? countries[0]! : null,
          specs: {
            countries,
            data_gb: Math.round((p.volume / GIB) * 100) / 100,
            validity_days: days,
            // 1 = total data; 2-4 = daily allowance plans
            daily_plan: p.dataType !== 1,
            speed: p.speed ?? null,
            sms: p.smsStatus === 1,
            slug: p.slug,
          },
          costUsd: p.price / MONEY_UNIT,
          requiredFields: [],
        };
      });
    },

    async quote(sku) {
      const { packageList } = await call<{ packageList: Package[] }>("/package/list", { packageCode: sku });
      const p = packageList[0];
      if (!p) throw new Error(`esimaccess package ${sku} not found`);
      return { costUsd: p.price / MONEY_UNIT };
    },

    async purchase(sku, _fields, idempotencyKey) {
      const obj = await call<{ orderNo: string }>("/esim/order", {
        transactionId: idempotencyKey,
        packageInfoList: [{ packageCode: sku, count: 1 }],
      });
      return { supplierOrderId: obj.orderNo };
    },

    async status(orderNo): Promise<SupplierStatus> {
      const esim = await firstEsim(orderNo);
      if (!esim) return "pending";
      if (DONE.has(esim.esimStatus) && esim.ac) return "done";
      if (FAILED.has(esim.esimStatus)) return "failed";
      return "pending";
    },

    async deliverable(orderNo) {
      const esim = await firstEsim(orderNo);
      if (!esim?.ac) throw new Error(`esimaccess order ${orderNo} has no profile yet`);
      return {
        type: "esim_lpa",
        payload: {
          lpa: esim.ac,
          qr_code_url: esim.qrCodeUrl ?? null,
          install_url: esim.shortUrl ?? null,
          iccid: esim.iccid,
          apn: esim.apn ?? null,
          pin: esim.pin ?? null,
          puk: esim.puk ?? null,
          expires_at: esim.expiredTime ?? null,
          esim_tran_no: esim.esimTranNo,
        },
      };
    },

    async balance() {
      const obj = await call<{ balance: number }>("/balance/query", {});
      return obj.balance / MONEY_UNIT;
    },
  };
}
