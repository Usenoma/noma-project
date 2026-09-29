export type Category = "esim" | "ai_credits" | "vpn" | "proxy" | "vps" | "giftcard";

export type DeliverableType =
  | "esim_lpa"
  | "vps_credentials"
  | "vpn_config"
  | "proxy_credentials"
  | "giftcard_code"
  | "api_key";

export interface RequiredField {
  name: string;
  label: string;
  type: "string" | "email" | "country" | "number";
  optional?: boolean;
}

export interface NormalizedProduct {
  supplierSku: string;
  category: Category;
  title: string;
  region: string | null;
  specs: Record<string, unknown>;
  costUsd: number;
  requiredFields: RequiredField[];
}

export interface Deliverable {
  type: DeliverableType;
  payload: Record<string, unknown>;
}

export type SupplierStatus = "pending" | "done" | "failed";

export interface SupplierAdapter {
  id: string;
  name: string;
  category: Category;
  syncCatalog(): Promise<NormalizedProduct[]>;
  quote(sku: string, fields: Record<string, string>): Promise<{ costUsd: number }>;
  /** Suppliers that only reveal the secret at creation time (e.g. API keys) return it inline. */
  purchase(
    sku: string,
    fields: Record<string, string>,
    idempotencyKey: string,
  ): Promise<{ supplierOrderId: string; deliverable?: Deliverable }>;
  status(supplierOrderId: string): Promise<SupplierStatus>;
  deliverable(supplierOrderId: string): Promise<Deliverable>;
  balance(): Promise<number>;
}
