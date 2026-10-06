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
  type: "string" | "email" | "country" | "number" | "select";
  optional?: boolean;
  options?: { value: string; label: string }[]; // for "select"
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
  /** Minimum time between catalog syncs (default: every catalog-sync tick). */
  catalogTtlMinutes?: number;
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
  /** Prepaid balance in USD, or null when the supplier API does not expose it. */
  balance(): Promise<number | null>;
  /**
   * Supplier order id a webhook notification is about, or null to ignore it. The payload is
   * untrusted: it only selects which order gets re-checked through status().
   */
  webhookOrderId?(payload: Record<string, unknown>): string | null;
  /** Time-limited products (e.g. VPS rentals): tear down the resource when the rental ends. */
  release?(supplierOrderId: string): Promise<void>;
}
