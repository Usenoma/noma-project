// API contract with the NOMA backend. Field names match the backend exactly.

export type Category = "esim" | "ai_credits" | "vpn" | "proxy" | "vps" | "giftcard";

export type DeliverableType =
  | "esim_lpa"
  | "vps_credentials"
  | "vpn_config"
  | "proxy_credentials"
  | "giftcard_code"
  | "api_key";

export type OrderStatus =
  | "created"
  | "awaiting_payment"
  | "paid"
  | "fulfilling"
  | "delivered"
  | "expired"
  | "failed"
  | "refunding"
  | "refunded";

export type PayAsset = "USDG" | "ETH";

export type InvoiceStatus =
  | "pending"
  | "seen"
  | "confirmed"
  | "underpaid"
  | "expired"
  | "late_paid";

export interface RequiredField {
  name: string;
  label: string;
  type: "string" | "email" | "country" | "number" | "select";
  optional?: boolean;
  options?: { value: string; label: string }[];
}

export interface Product {
  id: string;
  supplier_id: string;
  category: Category;
  title: string;
  region: string | null;
  specs: Record<string, unknown>;
  price_usd: string;
  required_fields: RequiredField[];
  available: boolean;
}

export interface Invoice {
  asset: string;
  amount: string;
  pay_to: string;
  payment_ref: string;
  expires_at: string;
  tx_hash: string | null;
  confirmations: number;
  status: InvoiceStatus;
  received?: string;
  payer_address?: string | null;
}

export interface PaymentClaim {
  id: string;
  order_id: string;
  tx_hash: string;
  asset: string;
  amount: string;
  payer_address: string | null;
  status: "open" | "accepted" | "rejected";
  note: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface Refund {
  id: string;
  kind: "full" | "overpayment";
  amount: string;
  asset: string;
  to_address: string;
  tx_hash: string | null;
  status: "pending" | "sent" | "confirmed" | "failed";
  created_at: string;
}

export interface AdminRefund {
  id: string;
  order_id: string;
  kind: "full" | "overpayment";
  amount: string;
  asset: string;
  to_address: string;
  tx_hash: string | null;
  status: "pending" | "sent" | "confirmed" | "failed";
  created_at: string;
}

export interface CreatedInvoice extends Invoice {
  id: string;
  chain: string;
}

export interface Deliverable {
  type: DeliverableType;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface OrderView {
  id: string;
  product_id: string;
  title: string;
  price_usd: string;
  status: OrderStatus;
  created_at: string;
  invoice: Invoice | null;
  refunds: Refund[];
  payment_claims: PaymentClaim[];
  deliverables: Deliverable[];
}

export interface CreateOrderResponse {
  order_id: string;
  order_key: string;
  invoice: CreatedInvoice;
}

export interface OrderSummary {
  id: string;
  product_id: string;
  title: string;
  wallet_address: string | null;
  price_usd: string;
  status: OrderStatus;
  created_at: string;
  has_deliverable: boolean;
}

export interface WalletSession {
  token: string;
  address: string;
  expires_at: string;
}

export interface OrdersPage {
  orders: OrderSummary[];
  total: number;
  spend_usd: string;
  limit: number;
  offset: number;
}

export interface AiUsageSnapshot {
  credit_usd: number;
  used_usd: number;
  reserved_usd: number;
  remaining_usd: number;
  expires_at: string | null;
  models: string[];
  key_last4: string;
}

export interface AiUsageRow {
  id: string;
  model: string;
  status: "reserved" | "settled" | "failed";
  reserved_usd: number;
  retail_cost_usd: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  created_at: string;
  settled_at: string | null;
}

// Rewards

export interface RewardsCurrent {
  total_staked: string;
  cycle: {
    week_no: number;
    stock_of_the_week: { symbol: string; token_address: string | null };
    starts_at: string;
    next_distribution_at: string;
  } | null;
  pools?: {
    quote_asset: string;
    zec_pool: { amount: string; usd: string };
    stock_pool: { amount: string; usd: string };
    total: { amount: string; usd: string };
    updated_at: string;
  } | null;
}

export interface RewardCycleHistory {
  week_no: number;
  stock_symbol: string;
  ends_at: string;
  acquisitions: {
    asset: "ZEC" | "STOCK";
    amount_in: string;
    amount_out: string;
    usd_value: string | null;
    tx_hash: string;
  }[];
  streamed_to_stakers: {
    asset: string;
    amount: string;
    amount_usd: string | null;
    stream_end: string;
    tx_hash: string;
  }[];
  recipients: string;
}

export interface RewardTransaction {
  kind: "escrow_claim" | "acquisition" | "staking_reward";
  week_no: number | null;
  asset: string;
  amount: string;
  usd_value: string | null;
  tx_hash: string;
  ts: string;
}

export interface Methodology {
  version: string;
  kind: string;
  unstake_cooldown_seconds: number;
  reward_stream_seconds: number;
  rules: string[];
}

// Lookup / Collection

export interface LookupResult {
  address: string;
  eligible: boolean;
  staked: string;
  pending_unstake: string;
  unlock_at: string | null;
  claimable: { asset: string; asset_address: string; amount: string; usd: string | null }[];
  total_claimed: { asset: string; amount: string; usd: string }[];
  total_claimed_usd: string;
  genesis: boolean;
  next_distribution_at: string | null;
}

export interface CollectionResult {
  address: string;
  genesis: boolean;
  companies_count: number;
  entries: {
    week_no: number;
    asset_symbol: string;
    amount: string;
    usd_value: string | null;
    tx_hash: string;
  }[];
  claims: {
    asset: string;
    amount: string;
    amount_usd: string | null;
    tx_hash: string;
    ts: string;
  }[];
  usd_totals: Record<string, string>;
}

// Agent

export interface AgentOption {
  product_id: string;
  category: Category;
  title: string;
  region: string | null;
  price_usd: string;
  specs: Record<string, unknown>;
}

export interface AgentChatResponse {
  session_id: string;
  message: string;
  options: AgentOption[];
}

// Deliverable payloads (per type)

export interface EsimLpaPayload {
  lpa: string;
  qr_code_url: string | null;
  install_url: string | null;
  iccid: string;
  apn: string | null;
  pin: string | null;
  puk: string | null;
  expires_at: string | null;
  esim_tran_no: string;
}

export interface VpsCredentialsPayload {
  ipv4: string;
  username: string;
  password: string;
  ssh: string;
  expires_in_days: number;
  note: string;
}

export interface VpnConfigPayload {
  username: string;
  password: string;
  server: string;
  openvpn: { file_name: string; file_body: string };
  wireguard: { file_name: string; file_body: string };
  note: string;
}

export interface ProxyCredentialsPayload {
  host: string;
  ports: { http: number; socks5: number };
  username: string;
  password: string;
  traffic_gb: number;
  examples: { http: string; socks5: string; country: string; sticky_session: string };
  note: string;
}

export interface GiftcardCodePayload {
  code?: string;
  [k: string]: unknown;
}

export interface ApiKeyPayload {
  api_key: string;
  base_url: string;
  credit_usd?: string;
  expires_at?: string | null;
  models?: string[];
  usage_url?: string;
  key_last4?: string;
  revoked_at?: string | null;
}

// Post-launch features (gated by FEATURES.*; see frontend.md §11)

export interface CapsuleItem {
  category: string;
  title: string;
  product: {
    id: string;
    title: string;
    price_usd: string;
    required_fields: RequiredField[];
  } | null;
}

export interface Capsule {
  slug: string;
  title: string;
  outcome: string;
  items: CapsuleItem[];
  total_usd: string;
  available: boolean;
}

export interface CapsuleOrderResult {
  slug: string;
  group_id: string;
  orders: {
    order_id: string;
    order_key: string;
    item: string;
    invoice: CreatedInvoice;
  }[];
}

export interface Subscription {
  id: string;
  owner: string;
  service: string;
  supplier_id: string | null;
  order_id: string | null;
  renewal_at: string | null;
  price_usd: string | null;
  status: "active" | "cancelled" | "expired";
  last_seen_at: string | null;
  recommendation: string | null;
}

export interface AliasPreview {
  field: string;
  label: string;
  real: string;
  sent: string;
  aliased: boolean;
}

export interface AliasPreviewResult {
  fields: Record<string, string>;
  aliases: AliasPreview[];
}

// Ghost Agent (gated by FEATURES.ghostAgent; see backend.md §15.5 / frontend.md §11.6)

export type GhostField = "email" | "name" | "phone" | "address" | "wallet";
export type GhostRuleMode = "alias" | "deny";
export type GhostRules = Record<GhostField, GhostRuleMode>;

export interface GhostProfile {
  id: string;
  name: string;
  email_alias: string;
  aliases: Record<string, string>;
  active: boolean;
}

export interface GhostVaultCreated {
  vault_key: string;
  key_last4: string;
  profiles: GhostProfile[];
  rules: GhostRules;
}

export interface GhostVaultView {
  key_last4: string;
  budget_usd: number;
  remaining_usd: number;
  profiles: GhostProfile[];
  rules: GhostRules;
}

export interface GhostPurchase {
  order_id: string;
  order_key: string;
  product_id: string;
  title: string;
  price_usd: number;
  asset: string;
  amount: string;
  pay_to: string;
  expires_at: string;
}

export interface GhostRecommendation {
  name: string;
  price_usd?: number;
  privacy_note: string;
  url?: string;
  reason: string;
}

export interface GhostPermissionRequest {
  mission_id: string;
  field: string;
  reason: string;
  has_alias: boolean;
}

export interface GhostChatResponse {
  mission_id: string;
  message: string;
  recommendations: GhostRecommendation[];
  purchases: GhostPurchase[];
  permission_request: GhostPermissionRequest | null;
}

export interface GhostMissionSummary {
  id: string;
  title: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface GhostMission {
  id: string;
  title: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  messages: { id: number; role: "user" | "assistant"; content: string; created_at: string }[];
}

export interface GhostReceipt {
  mission_id: string;
  title: string | null;
  status: string;
  created_at: string;
  sites_visited: string[];
  actions: Record<string, number>;
  permissions: { field: string; decision: "approve" | "alias" | "deny" }[];
  info_shared: { real: string[]; aliased: { field: string; value: string }[] };
  recommendations: GhostRecommendation[];
  purchases: { order_id: string; title: string; price_usd: number }[];
}
