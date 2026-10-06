import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { createBitrefillAdapter } from "../src/suppliers/bitrefill.js";
import { createEsimAccessAdapter } from "../src/suppliers/esimaccess.js";
import { createIpRoyalAdapter } from "../src/suppliers/iproyal.js";
import { createVpnResellersAdapter } from "../src/suppliers/vpnresellers.js";
import { webhookToken, webhookTokenMatches, webhookUrl } from "../src/suppliers/webhooks.js";

/**
 * Fake supplier APIs built from the documented request/response shapes (VPNresellers v3.2,
 * IPRoyal residential + reseller). Each route returns [status, body]; every call is recorded.
 */
type Route = (req: { method: string; url: URL; body: any }) => [number, unknown] | undefined;
function fakeFetch(routes: Route[]) {
  const calls: { method: string; path: string; body: any; headers: Record<string, string> }[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname + url.search, body, headers: init.headers as Record<string, string> });
    for (const r of routes) {
      const hit = r({ method, url, body });
      if (hit) return new Response(JSON.stringify(hit[1]), { status: hit[0] });
    }
    return new Response(JSON.stringify({ message: "Not Found." }), { status: 404 });
  });
  return calls;
}
const on =
  (method: string, path: RegExp, reply: (req: { url: URL; body: any }) => [number, unknown]): Route =>
  (req) =>
    req.method === method && path.test(req.url.pathname) ? reply(req) : undefined;

afterEach(() => vi.unstubAllGlobals());
const secret = Buffer.alloc(32, 9);
const ORDER = "7f1c2e0a-1111-4222-8333-944455556666";

describe("VPNresellers adapter", () => {
  const servers = {
    data: [
      { id: 1, name: "ams-s02.321inter.net", ip: "46.249.36.188", country_code: "NL", city: "Amsterdam", capacity: 0 },
      { id: 7, name: "nyc-s01.321inter.net", ip: "1.2.3.4", country_code: "US", city: "New York", capacity: 0 },
    ],
  };
  const account = (id: number, username: string) => ({ data: { id, username, status: "Active", expired_at: null, wg_ip: "10.250.1.2" } });

  it("lists duration products with every country and a server choice", async () => {
    fakeFetch([on("GET", /\/servers$/, () => [200, servers])]);
    const a = createVpnResellersAdapter("tok", secret, { monthlyUsd: 1.99 });
    const products = await a.syncCatalog();
    expect(products.map((p) => [p.supplierSku, p.costUsd, p.specs.duration_days])).toEqual([
      ["vpn-30d", 1.99, 30],
      ["vpn-90d", 5.97, 90],
      ["vpn-180d", 11.94, 180],
    ]);
    expect(products[0]!.specs.countries).toEqual(["NL", "US"]);
    expect(products[0]!.requiredFields[0]!.options).toEqual([
      { value: "1", label: "Amsterdam, NL" },
      { value: "7", label: "New York, US" },
    ]);
  });

  it("creates the account once, sets a supplier-side expiry, and survives a retried purchase", async () => {
    let created: { username: string; password: string } | undefined;
    const calls = fakeFetch([
      on("GET", /\/servers$/, () => [200, servers]),
      on("POST", /\/accounts$/, ({ body }) => {
        if (created) return [422, { message: "The given data was invalid.", errors: { username: ["The username has already been taken."] } }];
        created = body;
        return [201, account(42, body.username)];
      }),
      on("GET", /\/accounts$/, () => [200, { data: [account(41, "someoneelse").data, account(42, created!.username).data], links: { next: null } }]),
      on("PUT", /\/accounts\/42\/expire$/, () => [200, account(42, created!.username)]),
    ]);
    const a = createVpnResellersAdapter("tok", secret, { monthlyUsd: 1.99 });
    const first = await a.purchase("vpn-30d", { server: "7" }, ORDER);
    const retry = await a.purchase("vpn-30d", { server: "7" }, ORDER);
    expect(first.supplierOrderId).toBe(`42|7|${ORDER}`);
    expect(retry.supplierOrderId).toBe(first.supplierOrderId);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2); // second one answered 422 → looked up
    expect(created!.username).toMatch(/^noma[0-9a-f]{24}$/);
    const expire = calls.find((c) => c.path.endsWith("/expire"))!.body.expire_at;
    const days = (Date.parse(expire) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(30);
    expect(days).toBeLessThan(32);
    expect(calls[0]!.headers.Authorization).toBe("Bearer tok");
  });

  it("rejects a server that is not offered", async () => {
    fakeFetch([on("GET", /\/servers$/, () => [200, servers])]);
    const a = createVpnResellersAdapter("tok", secret, { monthlyUsd: 1.99 });
    await expect(a.purchase("vpn-30d", { server: "999" }, ORDER)).rejects.toThrow(/not available/);
  });

  it("delivers credentials with OpenVPN and WireGuard configs for the chosen server", async () => {
    let createdPassword = "";
    fakeFetch([
      on("GET", /\/servers$/, () => [200, servers]),
      on("POST", /\/accounts$/, ({ body }) => {
        createdPassword = body.password;
        return [201, account(42, body.username)];
      }),
      on("PUT", /\/expire$/, () => [200, {}]),
      on("GET", /\/configuration$/, ({ url }) => [200, { data: { file_name: `US-${url.searchParams.get("server_id")}.ovpn`, file_body: "client\nremote 1.2.3.4 1194" } }]),
      on("GET", /\/accounts\/42\/wireguard-configuration$/, () => [200, { data: { file_name: "wg0.conf", file_body: "[Interface]\nPrivateKey = x" } }]),
    ]);
    const a = createVpnResellersAdapter("tok", secret, { monthlyUsd: 1.99 });
    const { supplierOrderId } = await a.purchase("vpn-30d", { server: "7" }, ORDER);
    const d = await a.deliverable(supplierOrderId);
    expect(d.type).toBe("vpn_config");
    expect(d.payload).toMatchObject({
      password: createdPassword, // re-derived at delivery, never stored
      server: "New York, US (nyc-s01.321inter.net)",
      openvpn: { file_name: "US-7.ovpn" },
      wireguard: { file_name: "wg0.conf" },
    });
  });

  it("release deletes the account and tolerates one already gone; balance is not exposed", async () => {
    const calls = fakeFetch([on("DELETE", /\/accounts\/42$/, () => [200, { data: null }])]);
    const a = createVpnResellersAdapter("tok", secret, { monthlyUsd: 1.99 });
    await a.release!(`42|7|${ORDER}`);
    await a.release!(`43|7|${ORDER}`); // 404
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE /v3_2/accounts/42", "DELETE /v3_2/accounts/43"]);
    expect(await a.balance()).toBeNull();
  });
});

describe("IPRoyal adapter", () => {
  it("prices each traffic package with the supplier's calculator", async () => {
    fakeFetch([on("GET", /calculate-pricing$/, ({ url }) => [200, { total: Number(url.searchParams.get("quantity")) * 4 }])]);
    const a = createIpRoyalAdapter("tok", secret);
    const products = await a.syncCatalog();
    expect(products.map((p) => [p.supplierSku, p.costUsd])).toEqual([
      ["resi-1gb", 4],
      ["resi-5gb", 20],
      ["resi-10gb", 40],
      ["resi-25gb", 100],
    ]);
  });

  it("buys only the missing traffic, then creates a sub-user with exactly the package; a retry creates nothing", async () => {
    let sub: any;
    const calls = fakeFetch([
      on("GET", /\/residential-subusers$/, () => [200, { data: sub ? [sub] : [] }]),
      on("GET", /\/residential\/me$/, () => [200, { available_traffic: 2.5, subusers_count: 0 }]),
      on("POST", /\/residential\/orders$/, () => [200, { id: 4, status: "confirmed", quantity: 3 }]),
      on("POST", /\/residential-subusers$/, ({ body }) => {
        sub = { id: 5, hash: "02JVRQ5BF83PTW19G1SRD955J0", username: body.username, traffic_available: body.traffic };
        return [200, sub];
      }),
    ]);
    const a = createIpRoyalAdapter("tok", secret);
    const first = await a.purchase("resi-5gb", {}, ORDER);
    const retry = await a.purchase("resi-5gb", {}, ORDER);
    expect(first.supplierOrderId).toBe(`02JVRQ5BF83PTW19G1SRD955J0|${ORDER}`);
    expect(retry.supplierOrderId).toBe(first.supplierOrderId);
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => [c.path, c.body])).toEqual([
      ["/v1/residential/orders", { quantity: 3, order_billing_type: "regular" }],
      ["/v1/residential-subusers", { username: sub.username, password: expect.any(String), traffic: 5 }],
    ]);
    expect(calls[0]!.headers.Authorization).toBe("Bearer tok");
  });

  it("delivers gateway credentials with the re-derived password", async () => {
    let password = "";
    fakeFetch([
      on("GET", /\/residential-subusers$/, () => [200, { data: [] }]),
      on("GET", /\/residential\/me$/, () => [200, { available_traffic: 100 }]),
      on("POST", /\/residential-subusers$/, ({ body }) => {
        password = body.password;
        return [200, { id: 5, hash: "H1", username: body.username, traffic_available: 1 }];
      }),
      on("GET", /\/residential-subusers\/H1$/, () => [200, { id: 5, hash: "H1", username: "x", traffic_available: 1 }]),
    ]);
    const a = createIpRoyalAdapter("tok", secret);
    const { supplierOrderId } = await a.purchase("resi-1gb", {}, ORDER);
    expect(await a.status(supplierOrderId)).toBe("done");
    const d = await a.deliverable(supplierOrderId);
    expect(d.type).toBe("proxy_credentials");
    expect(d.payload).toMatchObject({ host: "geo.iproyal.com", ports: { http: 12321, socks5: 32325 }, password, traffic_gb: 1 });
  });

  it("reads the reseller balance with the reseller auth header; null when that API refuses the token", async () => {
    const calls = fakeFetch([on("GET", /\/reseller\/balance$/, () => [200, 884.05])]);
    expect(await createIpRoyalAdapter("tok", secret).balance()).toBe(884.05);
    expect(calls[0]!.headers["X-Access-Token"]).toBe("tok");
    fakeFetch([on("GET", /\/reseller\/balance$/, () => [401, { message: "Unauthenticated." }])]);
    expect(await createIpRoyalAdapter("tok", secret).balance()).toBeNull();
  });
});

describe("supplier webhooks", () => {
  afterEach(() => {
    config.PUBLIC_API_URL = undefined;
  });

  it("derives a distinct URL secret per supplier and builds URLs only with a public base URL", () => {
    expect(webhookUrl("bitrefill", ORDER)).toBeUndefined();
    config.PUBLIC_API_URL = "https://api.example.com/";
    const token = webhookToken("bitrefill");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe(webhookToken("esimaccess"));
    expect(webhookUrl("bitrefill", ORDER)).toBe(`https://api.example.com/webhooks/suppliers/bitrefill/${token}?order=${ORDER}`);
    expect(webhookTokenMatches("bitrefill", token)).toBe(true);
    expect(webhookTokenMatches("esimaccess", token)).toBe(false);
    expect(webhookTokenMatches("bitrefill", "short")).toBe(false);
  });

  it("eSIM Access: only order notifications name an order", () => {
    const a = createEsimAccessAdapter("code:secret");
    // sample payloads from docs.esimaccess.com (Webhooks)
    const envelope = { notifyId: "447602ac1e5c4bb4980f786b0c2934d6", eventGenerateTime: "2026-04-22T17:16:34Z" };
    const ready = { ...envelope, notifyType: "ORDER_STATUS", content: { orderNo: "B26042217160011", orderStatus: "GOT_RESOURCE", transactionId: "7544949834056-1-TR_50_30" } };
    expect(a.webhookOrderId!(ready)).toBe("B26042217160011");
    expect(a.webhookOrderId!({ notifyType: "ORDER_STATUS", "content[orderNo]": "B1" })).toBe("B1"); // their test form sends a query string
    // setup check and per-profile events carry an orderNo too, but are not order notifications
    expect(a.webhookOrderId!({ ...envelope, notifyType: "CHECK_HEALTH", content: { orderNo: "1234567890", orderStatus: "Test" } })).toBeNull();
    expect(a.webhookOrderId!({ ...envelope, notifyType: "SMDP_EVENT", content: { orderNo: "B26042112200025", esimStatus: "IN_USE" } })).toBeNull();
    expect(a.webhookOrderId!({ notifyType: "DATA_USAGE", content: { orderNo: "B1" } })).toBeNull();
    expect(a.webhookOrderId!({ notifyType: "ORDER_STATUS", content: { orderNo: 5 } })).toBeNull();
    expect(a.webhookOrderId!({})).toBeNull();
  });

  it("Bitrefill: the invoice carries a per-order webhook URL when one is configured", async () => {
    const calls = fakeFetch([on("POST", /\/invoices$/, () => [200, { data: { id: "inv1", status: "unpaid" } }])]);
    const opts = { countries: ["US"], includeTestProducts: false };
    await createBitrefillAdapter("key", opts).purchase("prod|pkg", {}, ORDER);
    expect(calls[0]!.body).not.toHaveProperty("webhook_url");
    await createBitrefillAdapter("key", { ...opts, webhookUrl: (id) => `https://api.example.com/hook?order=${id}` }).purchase("prod|pkg", {}, ORDER);
    expect(calls[1]!.body).toMatchObject({ auto_pay: false, webhook_url: `https://api.example.com/hook?order=${ORDER}` });
  });
});
