import { config } from "../../config.js";
import { db, tx } from "../../db/pool.js";
import { decryptJson, encryptJson } from "../../lib/crypto.js";
import { HttpError, notFound } from "../../lib/errors.js";
import { encryptionKey } from "../../lib/keys.js";
import { aiMarkup, retailCost, round6 } from "./pricing.js";
import { decryptAiKey, generateAiKey, hashAiKey, validAiKey } from "./keys.js";

export interface AiKeyRow {
  id: string;
  order_id: string;
  key_hash: string;
  key_encrypted: string;
  key_last4: string;
  credit_usd: string;
  used_usd: string;
  reserved_usd: string;
  expires_at: Date | null;
  revoked_at: Date | null;
  rotated_at: Date | null;
  created_at: Date | null;
}

export interface AiKeyPayload extends Record<string, unknown> {
  api_key: string;
  base_url: string;
  credit_usd: string;
  expires_at: string | null;
  models: string[];
  usage_url: string;
  key_last4: string;
  revoked_at?: string | null;
}

const baseUrl = () => config.AI_PUBLIC_BASE_URL.replace(/\/$/, "");

function payloadFor(key: AiKeyRow): AiKeyPayload {
  return {
    api_key: decryptAiKey(key.key_encrypted),
    base_url: baseUrl(),
    credit_usd: Number(key.credit_usd).toFixed(2),
    expires_at: key.expires_at?.toISOString() ?? null,
    models: [...config.OPENROUTER_MODELS],
    usage_url: `${baseUrl()}/usage`,
    key_last4: key.key_last4,
    revoked_at: key.revoked_at?.toISOString() ?? null,
  };
}

/** Keep the stored order deliverable in sync after a buyer/admin rotation or revocation. */
async function syncDeliverable(key: AiKeyRow): Promise<void> {
  const { rows } = await db.query<{ payload_encrypted: string }>(
    "SELECT payload_encrypted FROM deliverables WHERE order_id = $1 AND type = 'api_key'",
    [key.order_id],
  );
  if (!rows[0]) return;
  const current = decryptJson<Record<string, unknown>>(rows[0].payload_encrypted, encryptionKey);
  const next: AiKeyPayload = {
    ...current,
    api_key: decryptAiKey(key.key_encrypted),
    base_url: baseUrl(),
    credit_usd: Number(key.credit_usd).toFixed(2),
    expires_at: key.expires_at?.toISOString() ?? null,
    models: [...config.OPENROUTER_MODELS],
    usage_url: `${baseUrl()}/usage`,
    key_last4: key.key_last4,
    revoked_at: key.revoked_at?.toISOString() ?? null,
  };
  await db.query(
    "UPDATE deliverables SET payload_encrypted = $2 WHERE order_id = $1 AND type = 'api_key'",
    [key.order_id, encryptJson(next, encryptionKey)],
  );
}

/** Create the NOMA key for a paid AI-credit order. Idempotent by order id; the key stays recoverable. */
export async function issueKey(orderId: string): Promise<{ keyId: string; payload: AiKeyPayload }> {
  const { rows } = await db.query<{ price_usd: string; category: string }>(
    "SELECT o.price_usd, p.category FROM orders o JOIN products p ON p.id = o.product_id WHERE o.id = $1",
    [orderId],
  );
  const order = rows[0];
  if (!order) throw notFound("order");
  if (order.category !== "ai_credits") throw new Error(`order ${orderId} is not an AI credit order`);

  const existing = await db.query<AiKeyRow>("SELECT * FROM ai_keys WHERE order_id = $1", [orderId]);
  if (existing.rows[0]) return { keyId: existing.rows[0].id, payload: payloadFor(existing.rows[0]) };

  const material = generateAiKey();
  const expiresAt = new Date(Date.now() + config.AI_KEY_TTL_DAYS * 86_400_000);
  const inserted = await db.query<AiKeyRow>(
    `INSERT INTO ai_keys (order_id, key_hash, key_encrypted, key_last4, credit_usd, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (order_id) DO NOTHING
     RETURNING *`,
    [orderId, material.hash, material.encrypted, material.last4, order.price_usd, expiresAt],
  );
  const key =
    inserted.rows[0] ??
    (await db.query<AiKeyRow>("SELECT * FROM ai_keys WHERE order_id = $1", [orderId])).rows[0];
  if (!key) throw new Error(`failed to issue AI key for order ${orderId}`);
  return { keyId: key.id, payload: payloadFor(key) };
}

/** Deliverable recovery for a retried fulfillment. */
export async function deliverableFor(keyId: string): Promise<AiKeyPayload> {
  const { rows } = await db.query<AiKeyRow>("SELECT * FROM ai_keys WHERE id = $1", [keyId]);
  if (!rows[0]) throw notFound("AI key");
  return payloadFor(rows[0]);
}

export async function authenticate(authorization: string | undefined): Promise<AiKeyRow> {
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!token || !validAiKey(token)) throw new HttpError(401, "invalid api key");
  const { rows } = await db.query<AiKeyRow>("SELECT * FROM ai_keys WHERE key_hash = $1", [hashAiKey(token)]);
  const key = rows[0];
  if (!key) throw new HttpError(401, "invalid api key");
  if (key.revoked_at) throw new HttpError(401, "api key revoked");
  if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) throw new HttpError(401, "api key expired");
  return key;
}

export function balanceView(key: AiKeyRow) {
  const credit = Number(key.credit_usd);
  const used = Number(key.used_usd);
  const reserved = Number(key.reserved_usd);
  return {
    credit_usd: round6(credit),
    used_usd: round6(used),
    reserved_usd: round6(reserved),
    remaining_usd: round6(Math.max(credit - used - reserved, 0)),
    expires_at: key.expires_at?.toISOString() ?? null,
    models: [...config.OPENROUTER_MODELS],
    key_last4: key.key_last4,
  };
}

/** Reserve a conservative maximum before the upstream call. Throws 402 when the balance cannot cover it. */
export async function reserve(
  key: AiKeyRow,
  model: string,
  estimate: number,
): Promise<{ usageId: string; reserved: number }> {
  return tx(async (client) => {
    const { rows } = await client.query<AiKeyRow>("SELECT * FROM ai_keys WHERE id = $1 FOR UPDATE", [key.id]);
    const locked = rows[0];
    if (!locked) throw new HttpError(401, "invalid api key");
    if (locked.revoked_at) throw new HttpError(401, "api key revoked");
    if (locked.expires_at && new Date(locked.expires_at).getTime() <= Date.now()) {
      throw new HttpError(401, "api key expired");
    }
    const available = Number(locked.credit_usd) - Number(locked.used_usd) - Number(locked.reserved_usd);
    if (available < estimate) {
      throw new HttpError(402, `insufficient balance: $${Math.max(available, 0).toFixed(6)} remaining`);
    }
    await client.query("UPDATE ai_keys SET reserved_usd = reserved_usd + $2, updated_at = now() WHERE id = $1", [
      locked.id,
      estimate,
    ]);
    const { rows: usage } = await client.query<{ id: string }>(
      `INSERT INTO ai_usage (key_id, order_id, model, reserved_usd, status)
       VALUES ($1, $2, $3, $4, 'reserved') RETURNING id`,
      [locked.id, locked.order_id, model, estimate],
    );
    return { usageId: usage[0]!.id, reserved: estimate };
  });
}

/** Settle the actual upstream cost + platform fee onto the key. Idempotent per usage row. */
export async function settle(
  usageId: string,
  openrouterCost: number,
  promptTokens: number,
  completionTokens: number,
  generationId: string | null,
): Promise<void> {
  const markup = await aiMarkup();
  const retail = retailCost(openrouterCost, markup);
  await tx(async (client) => {
    const { rows } = await client.query<{ key_id: string; reserved_usd: string; status: string }>(
      "SELECT key_id, reserved_usd, status FROM ai_usage WHERE id = $1 FOR UPDATE",
      [usageId],
    );
    const usage = rows[0];
    if (!usage || usage.status !== "reserved") return;
    await client.query("SELECT 1 FROM ai_keys WHERE id = $1 FOR UPDATE", [usage.key_id]);
    await client.query(
      `UPDATE ai_keys
       SET used_usd = used_usd + $2, reserved_usd = GREATEST(reserved_usd - $3, 0), updated_at = now()
       WHERE id = $1`,
      [usage.key_id, retail, usage.reserved_usd],
    );
    await client.query(
      `UPDATE ai_usage
       SET status = 'settled', openrouter_cost_usd = $2, retail_cost_usd = $3,
           prompt_tokens = $4, completion_tokens = $5, generation_id = $6, settled_at = now()
       WHERE id = $1`,
      [usageId, openrouterCost, retail, promptTokens, completionTokens, generationId],
    );
  });
}

/** Upstream or validation failure: release the reservation and record the failed attempt. */
export async function release(usageId: string, error: string): Promise<void> {
  await tx(async (client) => {
    const { rows } = await client.query<{ key_id: string; reserved_usd: string; status: string }>(
      "SELECT key_id, reserved_usd, status FROM ai_usage WHERE id = $1 FOR UPDATE",
      [usageId],
    );
    const usage = rows[0];
    if (!usage || usage.status !== "reserved") return;
    await client.query("UPDATE ai_keys SET reserved_usd = GREATEST(reserved_usd - $2, 0), updated_at = now() WHERE id = $1", [
      usage.key_id,
      usage.reserved_usd,
    ]);
    await client.query("UPDATE ai_usage SET status = 'failed', error = $2 WHERE id = $1", [
      usageId,
      error.slice(0, 500),
    ]);
  });
}

export async function revokeKey(keyId: string): Promise<void> {
  const { rows } = await db.query<AiKeyRow>(
    "UPDATE ai_keys SET revoked_at = now(), updated_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING *",
    [keyId],
  );
  if (!rows[0]) throw notFound("AI key");
  await syncDeliverable(rows[0]);
}

/** Buyer-initiated rotation: invalidates the old key, keeps credit/usage, updates the deliverable. */
export async function rotateOrderKey(orderId: string): Promise<{ key_last4: string }> {
  const existing = await db.query<AiKeyRow>("SELECT * FROM ai_keys WHERE order_id = $1", [orderId]);
  if (!existing.rows[0]) throw notFound("AI key");
  const material = generateAiKey();
  const { rows } = await db.query<AiKeyRow>(
    `UPDATE ai_keys
     SET key_hash = $2, key_encrypted = $3, key_last4 = $4, revoked_at = NULL, rotated_at = now(),
         updated_at = now()
     WHERE id = $1 RETURNING *`,
    [existing.rows[0].id, material.hash, material.encrypted, material.last4],
  );
  await syncDeliverable(rows[0]!);
  return { key_last4: rows[0]!.key_last4 };
}

/** Buyer-initiated revocation. The buyer can rotate afterwards to get a fresh key with the same balance. */
export async function revokeOrderKey(orderId: string): Promise<void> {
  const { rows } = await db.query<AiKeyRow>(
    "UPDATE ai_keys SET revoked_at = now(), updated_at = now() WHERE order_id = $1 RETURNING *",
    [orderId],
  );
  if (!rows[0]) throw notFound("AI key");
  await syncDeliverable(rows[0]);
}

/**
 * A request that crashed between reserve and settle would otherwise lock credit forever.
 * Called by the worker; idempotent and safe with multiple workers (FOR UPDATE SKIP LOCKED).
 */
export async function reapStaleReservations(
  olderThanMinutes = config.AI_RESERVATION_TIMEOUT_MINUTES,
): Promise<number> {
  return tx(async (client) => {
    const { rows } = await client.query<{ id: string; key_id: string; reserved_usd: string }>(
      `SELECT id, key_id, reserved_usd FROM ai_usage
       WHERE status = 'reserved' AND created_at < now() - make_interval(mins => $1::int)
       ORDER BY created_at LIMIT 100
       FOR UPDATE SKIP LOCKED`,
      [olderThanMinutes],
    );
    for (const usage of rows) {
      await client.query(
        "UPDATE ai_keys SET reserved_usd = GREATEST(reserved_usd - $2, 0), updated_at = now() WHERE id = $1",
        [usage.key_id, usage.reserved_usd],
      );
      await client.query(
        "UPDATE ai_usage SET status = 'failed', error = 'stale reservation released', settled_at = now() WHERE id = $1",
        [usage.id],
      );
    }
    return rows.length;
  });
}

export async function usageHistory(keyId: string, limit = 20) {
  const { rows } = await db.query<{
    id: string;
    model: string;
    status: string;
    reserved_usd: string;
    retail_cost_usd: string | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    created_at: Date;
    settled_at: Date | null;
  }>(
    `SELECT id, model, status, reserved_usd, retail_cost_usd, prompt_tokens, completion_tokens,
            created_at, settled_at
     FROM ai_usage WHERE key_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [keyId, Math.min(Math.max(Math.trunc(limit), 1), 100)],
  );
  return rows.map((row) => ({
    id: row.id,
    model: row.model,
    status: row.status,
    reserved_usd: Number(row.reserved_usd),
    retail_cost_usd: row.retail_cost_usd === null ? null : Number(row.retail_cost_usd),
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    created_at: row.created_at.toISOString(),
    settled_at: row.settled_at?.toISOString() ?? null,
  }));
}

export async function aiKeySummary(filter: { keyId?: string; orderId?: string } = {}) {
  const where = filter.keyId ? "WHERE k.id = $1" : filter.orderId ? "WHERE k.order_id = $1" : "";
  const params = filter.keyId ? [filter.keyId] : filter.orderId ? [filter.orderId] : [];
  const { rows } = await db.query<AiKeyRow & { title: string }>(
    `SELECT k.*, p.title FROM ai_keys k
     JOIN orders o ON o.id = k.order_id
     JOIN products p ON p.id = o.product_id
     ${where}
     ORDER BY k.created_at DESC LIMIT 50`,
    params,
  );
  return rows.map((k) => ({
    id: k.id,
    order_id: k.order_id,
    title: k.title,
    ...balanceView(k),
    revoked_at: k.revoked_at?.toISOString() ?? null,
    created_at: k.created_at?.toISOString() ?? null,
  }));
}
