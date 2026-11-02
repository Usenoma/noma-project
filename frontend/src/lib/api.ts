import type {
  AdminRefund,
  AgentChatResponse,
  AliasPreviewResult,
  Capsule,
  CapsuleOrderResult,
  Category,
  CollectionResult,
  CreateOrderResponse,
  GhostChatResponse,
  GhostMission,
  GhostMissionSummary,
  GhostProfile,
  GhostReceipt,
  GhostRules,
  GhostVaultCreated,
  GhostVaultView,
  LookupResult,
  Methodology,
  OrderView,
  OrdersPage,
  PayAsset,
  PaymentClaim,
  Product,
  RewardsCurrent,
  RewardCycleHistory,
  RewardTransaction,
  Subscription,
  WalletSession,
} from "./types";

// Same-origin via the /api rewrite (API_ORIGIN env) in prod. Override with
// NEXT_PUBLIC_API_URL for direct local dev against the backend port.
const API = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let msg = `request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      // keep default
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface CatalogQuery {
  category?: Category;
  region?: string;
  q?: string;
  sort?: "price_asc" | "price_desc" | "title";
  maxPrice?: number;
  specs?: Record<string, number>;
  limit?: number;
  offset?: number;
}

export interface CatalogPage {
  products: Product[];
  total: number;
  limit: number;
  offset: number;
}

export async function getCatalog(query: CatalogQuery = {}): Promise<CatalogPage> {
  const params = new URLSearchParams();
  if (query.category) params.set("category", query.category);
  if (query.region) params.set("region", query.region);
  if (query.q) params.set("q", query.q);
  if (query.sort) params.set("sort", query.sort);
  if (query.maxPrice !== undefined) params.set("max_price", String(query.maxPrice));
  if (query.specs) params.set("specs", JSON.stringify(query.specs));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  const qs = params.toString();
  return req(`/catalog${qs ? `?${qs}` : ""}`);
}

export async function getCatalogFacets(query: {
  category?: Category;
  q?: string;
  maxPrice?: number;
  specs?: Record<string, number>;
} = {}): Promise<{ regions: { region: string; count: number }[] }> {
  const params = new URLSearchParams();
  if (query.category) params.set("category", query.category);
  if (query.q) params.set("q", query.q);
  if (query.maxPrice !== undefined) params.set("max_price", String(query.maxPrice));
  if (query.specs) params.set("specs", JSON.stringify(query.specs));
  const qs = params.toString();
  return req(`/catalog/facets${qs ? `?${qs}` : ""}`);
}

export async function getProduct(id: string): Promise<Product> {
  return req(`/catalog/${id}`);
}

export async function createOrder(input: {
  product_id: string;
  fields?: Record<string, string>;
  pay_asset: PayAsset;
  wallet?: string;
  walletAuth?: { token?: string; address?: string; signature?: string; timestamp?: string | number };
}): Promise<CreateOrderResponse> {
  const headers: Record<string, string> = {};
  if (input.walletAuth?.token) {
    headers.authorization = `Bearer ${input.walletAuth.token}`;
  } else if (input.walletAuth?.address && input.walletAuth.signature && input.walletAuth.timestamp !== undefined) {
    headers["x-wallet-address"] = input.walletAuth.address;
    headers["x-wallet-signature"] = input.walletAuth.signature;
    headers["x-wallet-timestamp"] = String(input.walletAuth.timestamp);
  }
  return req(`/orders`, {
    method: "POST",
    body: JSON.stringify({
      product_id: input.product_id,
      fields: input.fields,
      pay_asset: input.pay_asset,
      wallet: input.wallet,
    }),
    headers,
  });
}

export async function getOrder(
  id: string,
  orderKey?: string,
  walletToken?: string,
): Promise<OrderView> {
  const headers: Record<string, string> = {};
  if (orderKey) headers["x-order-key"] = orderKey;
  if (walletToken) headers.authorization = `Bearer ${walletToken}`;
  return req(`/orders/${id}`, { headers });
}

export async function createPaymentClaim(
  id: string,
  txHash: string,
  orderKey?: string,
  walletToken?: string,
): Promise<{ claim: PaymentClaim }> {
  const headers: Record<string, string> = {};
  if (orderKey) headers["x-order-key"] = orderKey;
  if (walletToken) headers.authorization = `Bearer ${walletToken}`;
  return req(`/orders/${id}/payment-claim`, {
    method: "POST",
    body: JSON.stringify({ tx_hash: txHash }),
    headers,
  });
}

export async function rotateAiKey(
  id: string,
  orderKey?: string,
  walletToken?: string,
): Promise<{ key_last4: string }> {
  const headers: Record<string, string> = {};
  if (orderKey) headers["x-order-key"] = orderKey;
  if (walletToken) headers.authorization = `Bearer ${walletToken}`;
  return req(`/orders/${id}/ai-key/rotate`, { method: "POST", headers });
}

export async function revokeAiKey(
  id: string,
  orderKey?: string,
  walletToken?: string,
): Promise<{ ok: boolean }> {
  const headers: Record<string, string> = {};
  if (orderKey) headers["x-order-key"] = orderKey;
  if (walletToken) headers.authorization = `Bearer ${walletToken}`;
  return req(`/orders/${id}/ai-key/revoke`, { method: "POST", headers });
}

export async function createWalletSession(input: {
  address: string;
  signature: string;
  timestamp: string | number;
}): Promise<WalletSession> {
  return req(`/auth/wallet`, { method: "POST", body: JSON.stringify(input) });
}

export async function getOrdersByWallet(
  token: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<OrdersPage> {
  const params = new URLSearchParams();
  params.set("limit", String(opts.limit ?? 20));
  params.set("offset", String(opts.offset ?? 0));
  return req(`/orders?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

export async function getRewardsCurrent(): Promise<RewardsCurrent> {
  return req(`/rewards/current`);
}

export async function getRewardsHistory(): Promise<{ cycles: RewardCycleHistory[] }> {
  return req(`/rewards/history`);
}

export async function getRewardsTransactions(
  limit = 100,
): Promise<{ transactions: RewardTransaction[] }> {
  return req(`/rewards/transactions?limit=${limit}`);
}

export async function getMethodology(): Promise<Methodology> {
  return req(`/rewards/methodology`);
}

export async function getLookup(address: string): Promise<LookupResult> {
  return req(`/lookup/${address}`);
}

export async function getCollection(address: string): Promise<CollectionResult> {
  return req(`/collection/${address}`);
}

export async function agentChat(input: {
  session_id?: string;
  message: string;
}): Promise<AgentChatResponse> {
  return req(`/agent/chat`, { method: "POST", body: JSON.stringify(input) });
}

// Post-launch features (gated; endpoints answer "not enabled" until switched on)

export async function getCapsules(): Promise<{ capsules: Capsule[] }> {
  return req(`/capsules`);
}

export async function getCapsule(slug: string): Promise<Capsule> {
  return req(`/capsules/${slug}`);
}

export async function buyCapsule(
  slug: string,
  fields: Record<string, string>,
  payAsset: PayAsset,
  walletAuth?: { wallet?: string; token?: string; address?: string; signature?: string; timestamp?: string | number },
): Promise<CapsuleOrderResult> {
  const headers: Record<string, string> = {};
  if (walletAuth?.token) headers.authorization = `Bearer ${walletAuth.token}`;
  else if (walletAuth?.address && walletAuth.signature && walletAuth.timestamp !== undefined) {
    headers["x-wallet-address"] = walletAuth.address;
    headers["x-wallet-signature"] = walletAuth.signature;
    headers["x-wallet-timestamp"] = String(walletAuth.timestamp);
  }
  return req(`/capsules/${slug}/orders`, {
    method: "POST",
    body: JSON.stringify({ fields, pay_asset: payAsset, wallet: walletAuth?.wallet }),
    headers,
  });
}

export async function getSubscriptions(
  owner: string,
  walletToken: string,
): Promise<{ subscriptions: Subscription[] }> {
  return req(`/subscriptions/${owner}`, {
    headers: { authorization: `Bearer ${walletToken}` },
  });
}

export async function decideSubscription(
  id: string,
  decision: "keep" | "cancel",
  walletToken: string,
): Promise<{ ok: boolean }> {
  return req(`/subscriptions/${id}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision }),
    headers: { authorization: `Bearer ${walletToken}` },
  });
}

export async function previewAliases(
  productId: string,
  fields: Record<string, string>,
): Promise<AliasPreviewResult> {
  return req(`/identity/aliases`, {
    method: "POST",
    body: JSON.stringify({ product_id: productId, fields }),
  });
}

// Ghost Agent (gated; endpoints answer "not enabled" until switched on)

const ghostHeaders = (vaultKey: string) => ({ "x-ghost-key": vaultKey });

export async function ghostVaultCreate(): Promise<GhostVaultCreated> {
  return req(`/ghost/vault`, { method: "POST", body: "{}" });
}

export async function ghostVaultGet(vaultKey: string): Promise<GhostVaultView> {
  return req(`/ghost/vault`, { headers: ghostHeaders(vaultKey) });
}

export async function ghostProfileCreate(vaultKey: string, name: string): Promise<GhostProfile> {
  return req(`/ghost/profiles`, {
    method: "POST",
    body: JSON.stringify({ name }),
    headers: ghostHeaders(vaultKey),
  });
}

export async function ghostProfileUpdate(vaultKey: string, id: string, name: string): Promise<GhostProfile> {
  return req(`/ghost/profiles/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
    headers: ghostHeaders(vaultKey),
  });
}

export async function ghostProfileDelete(vaultKey: string, id: string): Promise<void> {
  return req(`/ghost/profiles/${id}`, { method: "DELETE", headers: ghostHeaders(vaultKey) });
}

export async function ghostRulesSet(vaultKey: string, rules: Partial<GhostRules>): Promise<{ rules: GhostRules }> {
  return req(`/ghost/rules`, {
    method: "PUT",
    body: JSON.stringify({ rules }),
    headers: ghostHeaders(vaultKey),
  });
}

export async function ghostBudgetSet(
  vaultKey: string,
  maxUsd: number,
): Promise<{ budget_usd: number; remaining_usd: number }> {
  return req(`/ghost/budget`, {
    method: "PUT",
    body: JSON.stringify({ max_usd: maxUsd }),
    headers: ghostHeaders(vaultKey),
  });
}

export async function ghostChat(
  vaultKey: string,
  input: {
    mission_id?: string;
    message: string;
    permission?: { decision: "approve" | "alias" | "deny"; value?: string };
  },
): Promise<GhostChatResponse> {
  return req(`/ghost/chat`, {
    method: "POST",
    body: JSON.stringify(input),
    headers: ghostHeaders(vaultKey),
  });
}

export async function ghostMissionsList(vaultKey: string): Promise<{ missions: GhostMissionSummary[] }> {
  return req(`/ghost/missions`, { headers: ghostHeaders(vaultKey) });
}

export async function ghostMissionGet(vaultKey: string, id: string): Promise<GhostMission> {
  return req(`/ghost/missions/${id}`, { headers: ghostHeaders(vaultKey) });
}

export async function ghostMissionReceipt(vaultKey: string, id: string): Promise<GhostReceipt> {
  return req(`/ghost/missions/${id}/receipt`, { headers: ghostHeaders(vaultKey) });
}

// Internal ops console. The token is supplied by the operator and never bundled.
const adminHeaders = (token: string) => ({ authorization: `Bearer ${token}` });

export async function getAdminClaims(
  token: string,
  status: "open" | "accepted" | "rejected" = "open",
): Promise<{ claims: PaymentClaim[] }> {
  return req(`/admin/payment-claims?status=${status}`, { headers: adminHeaders(token) });
}

export async function resolveAdminClaim(
  token: string,
  id: string,
  action: "accept" | "reject",
  note?: string,
): Promise<{ orderId: string; queued: boolean }> {
  return req(`/admin/payment-claims/${id}/resolve`, {
    method: "POST",
    headers: adminHeaders(token),
    body: JSON.stringify({ action, note }),
  });
}

export async function getAdminRefunds(
  token: string,
  status: "pending" | "sent" | "confirmed" | "failed" = "failed",
): Promise<{ refunds: AdminRefund[] }> {
  return req(`/admin/refunds?status=${status}`, { headers: adminHeaders(token) });
}

export async function retryAdminRefund(
  token: string,
  orderId: string,
  kind: "full" | "overpayment" = "full",
): Promise<{ ok: boolean }> {
  return req(`/admin/orders/${orderId}/refund/retry`, {
    method: "POST",
    headers: adminHeaders(token),
    body: JSON.stringify({ kind }),
  });
}

export async function sendAdminTestAlert(
  token: string,
): Promise<{ ok: boolean; delivery_configured: boolean }> {
  return req(`/admin/alerts/test`, { method: "POST", headers: adminHeaders(token) });
}
