import type { SupplierAdapter } from "./types.js";

/** In-memory supplier for local development and tests. Never registered in production. */
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
