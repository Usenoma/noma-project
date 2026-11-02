import type { SupplierAdapter } from "./types.js";

/** In-memory suppliers for local development and tests. Never registered in production. */
export function createMockEsimAdapter(): SupplierAdapter {
  const orders = new Map<string, string>();
  return {
    id: "mock-esim",
    name: "Mock eSIM",
    category: "esim",
    async syncCatalog() {
      return [
        {
          supplierSku: "JP-20GB-30D",
          category: "esim",
          title: "Japan 20GB / 30 days",
          region: "JP",
          specs: { data_gb: 20, validity_days: 30 },
          costUsd: 18,
          requiredFields: [],
        },
        {
          supplierSku: "JP-10GB-15D",
          category: "esim",
          title: "Japan 10GB / 15 days",
          region: "JP",
          specs: { data_gb: 10, validity_days: 15 },
          costUsd: 11,
          requiredFields: [],
        },
      ];
    },
    async quote() {
      return { costUsd: 18 };
    },
    async purchase(sku, _fields, idempotencyKey) {
      const supplierOrderId = `mock_${idempotencyKey}`;
      orders.set(supplierOrderId, sku);
      return { supplierOrderId };
    },
    async status(supplierOrderId) {
      return orders.has(supplierOrderId) ? "done" : "failed";
    },
    async deliverable(supplierOrderId) {
      return {
        type: "esim_lpa",
        payload: { lpa: `LPA:1$mock.example$${supplierOrderId}`, iccid: "8900000000000000000" },
      };
    },
    async balance() {
      return 1000;
    },
  };
}

export function createMockVpnAdapter(): SupplierAdapter {
  const orders = new Map<string, string>();
  return {
    id: "mock-vpn",
    name: "Mock VPN",
    category: "vpn",
    async syncCatalog() {
      return [30, 90, 180].map((days) => ({
        supplierSku: `VPN-${days}D`,
        category: "vpn" as const,
        title: `VPN ${days} days`,
        region: null,
        specs: { duration_days: days, protocols: ["WireGuard", "OpenVPN"], devices: 5 },
        costUsd: (days / 30) * 1.99,
        requiredFields: [],
      }));
    },
    async quote() {
      return { costUsd: 1.99 };
    },
    async purchase(sku, _fields, idempotencyKey) {
      const supplierOrderId = `mockvpn_${idempotencyKey}`;
      orders.set(supplierOrderId, sku);
      return { supplierOrderId };
    },
    async status(supplierOrderId) {
      return orders.has(supplierOrderId) ? "done" : "failed";
    },
    async deliverable(supplierOrderId) {
      return {
        type: "vpn_config",
        payload: {
          username: `noma_${supplierOrderId.slice(-8)}`,
          password: "mock-password-change-me",
          server: "nl1.mock.example",
          openvpn: { file_name: "client.ovpn", file_body: "# mock openvpn config\nremote nl1.mock.example 1194" },
          wireguard: { file_name: "client.conf", file_body: "# mock wireguard config\n[Interface]\nPrivateKey = mock" },
          note: "mock account — demo only",
        },
      };
    },
    async balance() {
      return 1000;
    },
  };
}

export function createMockProxyAdapter(): SupplierAdapter {
  const orders = new Map<string, string>();
  return {
    id: "mock-proxy",
    name: "Mock Proxy",
    category: "proxy",
    async syncCatalog() {
      return [1, 5, 10, 25].map((gb) => ({
        supplierSku: `PROXY-${gb}GB`,
        category: "proxy" as const,
        title: `Residential proxy ${gb} GB`,
        region: null,
        specs: { proxy_type: "residential", traffic_gb: gb, protocols: ["http", "socks5"] },
        costUsd: gb * 1.5,
        requiredFields: [],
      }));
    },
    async quote() {
      return { costUsd: 1.5 };
    },
    async purchase(sku, _fields, idempotencyKey) {
      const supplierOrderId = `mockproxy_${idempotencyKey}`;
      orders.set(supplierOrderId, sku);
      return { supplierOrderId };
    },
    async status(supplierOrderId) {
      return orders.has(supplierOrderId) ? "done" : "failed";
    },
    async deliverable(supplierOrderId) {
      return {
        type: "proxy_credentials",
        payload: {
          host: "geo.mock.example",
          ports: { http: 12321, socks5: 32325 },
          username: `noma_${supplierOrderId.slice(-8)}`,
          password: "mock-proxy-password",
          traffic_gb: 1,
          examples: {
            http: "curl -x http://user:pass@geo.mock.example:12321 https://example.com",
            socks5: "curl -x socks5://user:pass@geo.mock.example:32325 https://example.com",
            country: "US",
            sticky_session: "session-123",
          },
          note: "mock proxy — demo only",
        },
      };
    },
    async balance() {
      return 1000;
    },
  };
}

export function createMockAiCreditsAdapter(): SupplierAdapter {
  const orders = new Map<string, string>();
  return {
    id: "mock-ai",
    name: "Mock AI credits",
    category: "ai_credits",
    async syncCatalog() {
      return [5, 25, 100].map((usd) => ({
        supplierSku: `AI-${usd}`,
        category: "ai_credits" as const,
        title: `OpenRouter ${usd} credit`,
        region: null,
        specs: { credit_usd: usd, provider: "OpenRouter" },
        costUsd: usd,
        requiredFields: [],
      }));
    },
    async quote() {
      return { costUsd: 5 };
    },
    async purchase(_sku, _fields, idempotencyKey) {
      const supplierOrderId = `mockai_${idempotencyKey}`;
      orders.set(supplierOrderId, _sku);
      return {
        supplierOrderId,
        deliverable: {
          type: "api_key",
          payload: { api_key: `sk-or-mock-${idempotencyKey.slice(-16)}`, base_url: "https://openrouter.ai/api/v1" },
        },
      };
    },
    async status(supplierOrderId) {
      return orders.has(supplierOrderId) ? "done" : "failed";
    },
    async deliverable(supplierOrderId) {
      return {
        type: "api_key",
        payload: { api_key: `sk-or-mock-${supplierOrderId.slice(-16)}`, base_url: "https://openrouter.ai/api/v1" },
      };
    },
    async balance() {
      return 1000;
    },
  };
}
