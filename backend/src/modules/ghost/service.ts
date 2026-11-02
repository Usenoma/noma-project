import { z } from "zod";
import { config } from "../../config.js";
import { db } from "../../db/pool.js";
import { badRequest, HttpError, notFound } from "../../lib/errors.js";
import { getProduct, listProducts } from "../catalog/service.js";
import { createOrder } from "../orders/service.js";
import { remainingBudget, recordPurchase } from "./payment.js";
import { aliasFor, activeProfile, type GhostProfile } from "./profiles.js";
import { evaluateRule, getRules, type GhostRuleMode } from "./rules.js";
import { fetchPage, searchWeb, type MissionEventLogger } from "./research.js";

/**
 * Ghost Agent missions: a tool-calling LLM loop that researches the public web under the
 * user's privacy rules. The model only ever sees synthetic aliases; real values are accepted
 * through a permission grant, logged into the event trail, and discarded without being stored
 * or shown to the model. The event trail is the Ghost Receipt.
 */

const SYSTEM_PROMPT = `You are the NOMA Ghost Agent. You research the public web to help users make privacy-aware decisions about digital services (VPS, VPN, eSIM, email, hosting and similar).

Rules:
- Research only through search_web and open_page. Never claim to have visited a page you did not fetch.
- Prefer options that ask for the least personal data. Compare privacy requirements explicitly: what signup fields, what verification, what payment methods each provider demands.
- Never invent prices, features or links. Cite the source (title + URL) for every claim.
- You cannot create accounts, buy anything or take payment. If asked, say the user completes those steps themselves.
- Identity data is governed by the user's privacy rules. To use any identity field call request_identity with the field name and a one-line reason. Never ask for more than the task needs.
- Aliases are synthetic, non-functional placeholders: use them only for signup forms that do not verify. Never offer an alias as if it were real for wallet or payment contexts.
- When you have concrete recommendations, call present_recommendations with 1-5 items and then summarize: privacy posture first, price second.
- Spend at most 4-6 search/fetch actions on a mission. Do not keep researching; once you can compare a few providers, present and stop.
- Ghost Payment: you may buy from NOMA's OWN catalog only (search_catalog + purchase_product), and only when the user explicitly asks you to buy something. Never buy on your own initiative. A spending budget must be set or purchases are refused. Collect any required delivery fields from the user first; never invent them. You never sign or move funds: purchase_product creates an order and the USER pays the invoice from their wallet.
Keep replies short and in plain text.`;

const WRAPUP_PROMPT =
  "You have gathered enough. Stop researching now. If you have findings, call " +
  "present_recommendations with your best 1-5 options, then write a short final summary " +
  "(privacy posture first, price second).";

const IDENTITY_FIELDS = ["email", "name", "phone", "address", "wallet", "payment", "other"] as const;

const searchInput = z.object({ query: z.string().min(1).max(500) });
const urlInput = z.object({ url: z.string().min(1).max(2000) });
const identityInput = z.object({
  field: z.enum(IDENTITY_FIELDS),
  reason: z.string().min(1).max(500),
});
const catalogInput = z.object({
  query: z.string().max(200).optional(),
  category: z.enum(["esim", "ai_credits", "vps", "giftcard"]).optional(),
  max_price: z.number().positive().optional(),
});
const purchaseInput = z.object({
  product_id: z.string().uuid(),
  reason: z.string().min(1).max(500),
  fields: z.record(z.string().max(500)).optional(),
});
const presentInput = z.object({
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        price_usd: z.number().nonnegative().optional(),
        privacy_note: z.string().min(1).max(500),
        url: z.string().url().optional(),
        reason: z.string().min(1).max(1000),
      }),
    )
    .min(1)
    .max(5),
});

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

/** An order created by the agent within the vault budget; the user pays it from their wallet. */
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

export interface GhostChatReply {
  mission_id: string;
  message: string;
  recommendations: GhostRecommendation[];
  purchases: GhostPurchase[];
  permission_request: GhostPermissionRequest | null;
}

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name?: string; content: string };

interface UpstreamMessage {
  role?: string;
  content?: string | null;
  tool_calls?: ToolCall[];
}

interface PendingPermission {
  tool_call_id: string;
  field: string;
  reason: string;
  has_alias: boolean;
}

interface MissionState {
  messages: ChatMessage[];
  pending: PendingPermission | null;
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Search the public web for current pages. Returns up to a few results with title, URL and a snippet.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_page",
      description: "Fetch one public page and return its readable text (up to ~12k characters). Use for pricing pages, privacy policies and signup requirements.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Full http(s) URL" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_identity",
      description:
        "Request identity data for a field before using or sharing it. The privacy rules decide whether a synthetic alias is shared automatically or the user is asked for approval.",
      parameters: {
        type: "object",
        properties: {
          field: { type: "string", enum: [...IDENTITY_FIELDS] },
          reason: { type: "string", description: "One line: why this field is needed for the task" },
        },
        required: ["field", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_catalog",
      description:
        "Search NOMA's own catalog for products the user can buy through you (eSIM, AI credits, VPS, gift cards). Use this before purchase_product; external websites cannot be purchased.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search" },
          category: { type: "string", enum: ["esim", "ai_credits", "vps", "giftcard"] },
          max_price: { type: "number", description: "USD" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "purchase_product",
      description:
        "Create a NOMA order within the vault's spending budget. Only when the user explicitly asked you to buy. The order needs every required delivery field (collect them from the user; never invent them). You never pay: the user settles the invoice from their own wallet.",
      parameters: {
        type: "object",
        properties: {
          product_id: { type: "string", description: "Product id from search_catalog" },
          reason: { type: "string", description: "One line: why this purchase serves the mission" },
          fields: {
            type: "object",
            description: "Required delivery fields, e.g. {\"email\": \"…\", \"os\": \"10008\"}",
            additionalProperties: { type: "string" },
          },
        },
        required: ["product_id", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "present_recommendations",
      description: "Show the user selectable recommendation cards, best privacy-first match first. Call once when you have 1-5 concrete options.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                price_usd: { type: "number" },
                privacy_note: { type: "string", description: "What personal data it demands and how private it is" },
                url: { type: "string", description: "Source page" },
                reason: { type: "string", description: "Why it fits the user's request" },
              },
              required: ["name", "privacy_note", "reason"],
              additionalProperties: false,
            },
          },
        },
        required: ["items"],
        additionalProperties: false,
      },
    },
  },
];

interface ToolContext {
  vaultId: string;
  missionId: string;
  setPresented: (items: GhostRecommendation[]) => void;
  addPurchase: (purchase: GhostPurchase) => void;
}

async function runTool(
  call: ToolCall,
  rules: Record<string, GhostRuleMode>,
  profile: GhostProfile | null,
  log: MissionEventLogger,
  ctx: ToolContext,
): Promise<{ content: string; pending: PendingPermission | null }> {
  const raw = JSON.parse(call.function.arguments || "{}");
  switch (call.function.name) {
    case "search_web": {
      const { query } = searchInput.parse(raw);
      const results = await searchWeb(query, log);
      if (results.length === 0) {
        return {
          content:
            "Web search returned no results (the search upstream may be temporarily unavailable). Answer from general knowledge only and tell the user you could not verify current prices or policies.",
          pending: null,
        };
      }
      return { content: JSON.stringify(results.map((r) => ({ title: r.title, url: r.url, snippet: r.content }))), pending: null };
    }
    case "open_page": {
      const { url } = urlInput.parse(raw);
      const text = await fetchPage(url, log);
      if (!text) return { content: `Could not fetch ${url} (blocked, unavailable or not a public page).`, pending: null };
      return { content: `Page text for ${url}:\n\n${text}`, pending: null };
    }
    case "request_identity": {
      const { field, reason } = identityInput.parse(raw);
      const rule = evaluateRule(rules, field);
      const alias = aliasFor(profile, field);
      if (rule === "alias" && alias) {
        await log("alias_used", { field, value: alias, by: "rule" });
        return {
          content: `Privacy rule for ${field} is "alias". Use the synthetic alias ${alias} — it is safe to share. Never present it as a real value for wallet or payment contexts.`,
          pending: null,
        };
      }
      await log("permission_ask", { field, reason, rule });
      return { content: "", pending: { tool_call_id: call.id, field, reason, has_alias: !!alias } };
    }
    case "search_catalog": {
      const input = catalogInput.parse(raw);
      const products = await listProducts({
        category: input.category,
        q: input.query,
        maxPrice: input.max_price,
        limit: 10,
      });
      return {
        content: JSON.stringify(
          products.map((p) => ({
            product_id: p.id,
            title: p.title,
            category: p.category,
            price_usd: p.price_usd,
            required_fields: p.required_fields.map((f) => ({
              name: f.name,
              label: f.label,
              type: f.type,
              optional: !!f.optional,
              options: f.options,
            })),
          })),
        ),
        pending: null,
      };
    }
    case "purchase_product": {
      const input = purchaseInput.parse(raw);
      const remaining = await remainingBudget(ctx.vaultId);
      if (remaining <= 0) {
        return {
          content:
            "Agent purchases are disabled: this vault has no remaining spending budget. Tell the user to set a budget in the vault settings first.",
          pending: null,
        };
      }
      const product = await getProduct(input.product_id);
      if (!product) {
        return { content: "Unknown product id. Use search_catalog and pick a listed product.", pending: null };
      }
      const price = Number(product.price_usd);
      if (price > remaining) {
        return {
          content: `Purchase refused: $${price.toFixed(2)} exceeds the remaining budget of $${remaining.toFixed(2)}. Tell the user and offer cheaper options.`,
          pending: null,
        };
      }
      let order: Awaited<ReturnType<typeof createOrder>>;
      try {
        order = await createOrder({ productId: product.id, fields: input.fields ?? {}, payAsset: "USDG" });
      } catch (err) {
        return {
          content: JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
            hint: "If a required delivery field is missing or invalid, collect it from the user and retry.",
          }),
          pending: null,
        };
      }
      await recordPurchase({
        vault_id: ctx.vaultId,
        mission_id: ctx.missionId,
        order_id: order.orderId,
        product_id: product.id,
        title: product.title,
        price_usd: price,
      });
      await log("purchase", {
        order_id: order.orderId,
        product_id: product.id,
        title: product.title,
        price_usd: price,
      });
      ctx.addPurchase({
        order_id: order.orderId,
        order_key: order.orderKey,
        product_id: product.id,
        title: product.title,
        price_usd: price,
        asset: order.invoice.asset,
        amount: order.invoice.amount,
        pay_to: order.invoice.pay_to,
        expires_at: order.invoice.expires_at.toISOString(),
      });
      return {
        content: `Order created: ${product.title} for $${price.toFixed(2)}. Invoice ${order.invoice.amount} ${order.invoice.asset} to ${order.invoice.pay_to}, expires ${order.invoice.expires_at.toISOString()}. The user pays from their wallet; show the order card and the remaining budget ($${(remaining - price).toFixed(2)}).`,
        pending: null,
      };
    }
    case "present_recommendations": {
      const { items } = presentInput.parse(raw);
      ctx.setPresented(items);
      await log("present", { items });
      return { content: `Presented ${items.length} recommendation(s) to the user.`, pending: null };
    }
    default:
      return { content: JSON.stringify({ error: `unknown tool: ${call.function.name}` }), pending: null };
  }
}

export type PermissionDecision = { decision: "approve" | "alias" | "deny"; value?: string };

export async function chat(
  vaultId: string,
  missionId: string | undefined,
  message: string,
  permission?: PermissionDecision,
): Promise<GhostChatReply> {
  // Ghost missions default to OpenRouter: privacy-focused prompts ("signup without a phone
  // number"…) get flagged by the MiMo-direct endpoint's moderation. GHOST_LLM_* overrides win.
  const apiKey = config.GHOST_LLM_API_KEY ?? config.OPENROUTER_API_KEY ?? config.LLM_API_KEY;
  if (!apiKey) throw new HttpError(503, "ghost agent not configured");
  const base = (config.GHOST_LLM_BASE_URL ?? config.OPENROUTER_BASE_URL ?? config.LLM_BASE_URL).replace(/\/$/, "");
  const model = config.GHOST_LLM_MODEL ?? config.LLM_MODEL;

  const rules = await getRules(vaultId);
  const profile = await activeProfile(vaultId);

  // load or create the mission; continuing a mission needs no pending ask unless a permission
  // decision is attached to the request
  let missionId2: string;
  let state: MissionState;
  if (missionId) {
    const { rows } = await db.query<{ id: string; state: MissionState }>(
      "SELECT id, state FROM ghost_missions WHERE id = $1 AND vault_id = $2",
      [missionId, vaultId],
    );
    if (!rows[0]) throw notFound("mission");
    missionId2 = rows[0].id;
    state = rows[0].state;
    await db.query("UPDATE ghost_missions SET status = 'running', updated_at = now() WHERE id = $1", [missionId2]);
  } else {
    const initialState: MissionState = {
      messages: [{ role: "system", content: SYSTEM_PROMPT }],
      pending: null,
    };
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO ghost_missions (vault_id, profile_id, title, state) VALUES ($1, $2, $3, $4) RETURNING id",
      [vaultId, profile?.id ?? null, message.slice(0, 80), initialState],
    );
    missionId2 = rows[0]!.id;
    state = initialState;
  }

  const log: MissionEventLogger = async (kind, detail) => {
    await db.query("INSERT INTO ghost_mission_events (mission_id, kind, detail) VALUES ($1, $2, $3)", [
      missionId2,
      kind,
      detail,
    ]);
  };

  const messages: ChatMessage[] = [...state.messages];

  // a follow-up carrying a permission decision resolves the pending ask before anything else
  if (permission) {
    const pending = state.pending;
    if (!pending) throw badRequest("no permission request pending");
    let content: string;
    if (permission.decision === "approve") {
      // the real value is validated and then intentionally discarded: it is logged as shared
      // (field only) and never stored, never shown to the model
      if (!permission.value?.trim()) throw badRequest("a value is required to approve sharing");
      await log("permission_grant", { field: pending.field, decision: "approve" });
      await log("data_shared", { field: pending.field, value_kind: "real" });
      content = `The user approved sharing their real ${pending.field} for this mission. It is recorded in the mission receipt; the value itself is not stored and is not shown to you. Proceed as if it was provided, and never print the value.`;
    } else if (permission.decision === "alias") {
      const alias = aliasFor(profile, pending.field);
      if (!alias) throw badRequest("no alias available for this field");
      await log("permission_grant", { field: pending.field, decision: "alias" });
      await log("alias_used", { field: pending.field, value: alias });
      content = `The user chose to share the synthetic alias for ${pending.field}: ${alias}. Use it for signup forms that do not verify; never present it as a real value for wallet or payment contexts.`;
    } else {
      await log("permission_deny", { field: pending.field, by: "user" });
      content = `The user denied sharing ${pending.field}. Work around it: prefer options that do not require this field, and do not ask again this mission.`;
    }
    messages.push({ role: "tool", tool_call_id: pending.tool_call_id, name: "request_identity", content });
  }

  messages.push({ role: "user", content: message });
  await db.query("INSERT INTO ghost_mission_messages (mission_id, role, content) VALUES ($1, 'user', $2)", [
    missionId2,
    message,
  ]);

  let presented: GhostRecommendation[] = [];
  const purchases: GhostPurchase[] = [];
  let reply = "";

  try {
    for (let turn = 0; turn < config.GHOST_MAX_TOOL_TURNS; turn++) {
      // nudge the model to wrap up two turns before the budget ends
      if (turn === config.GHOST_MAX_TOOL_TURNS - 2) {
        messages.push({ role: "user", content: WRAPUP_PROMPT });
      }
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": config.AI_PUBLIC_BASE_URL,
          "X-Title": "NOMA Ghost Agent",
        },
        body: JSON.stringify({
          model,
          messages,
          tools: TOOLS,
          tool_choice: "auto",
          max_tokens: 2048,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new HttpError(502, `ghost agent upstream ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as { choices?: { message?: UpstreamMessage }[] };
      const assistant = data.choices?.[0]?.message;
      if (!assistant) throw new HttpError(502, "ghost agent upstream returned no message");

      const toolCalls = assistant.tool_calls ?? [];
      messages.push({
        role: "assistant",
        content: assistant.content ?? null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      if (!toolCalls.length) {
        reply = (assistant.content ?? "").trim();
        break;
      }
      for (const call of toolCalls) {
        let result: { content: string; pending: PendingPermission | null };
        try {
          result = await runTool(call, rules, profile, log, {
            vaultId,
            missionId: missionId2,
            setPresented: (items) => {
              presented = items;
            },
            addPurchase: (purchase) => {
              purchases.push(purchase);
            },
          });
        } catch (err) {
          result = { content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), pending: null };
        }
        if (result.pending) {
          await db.query("UPDATE ghost_missions SET state = $2, updated_at = now() WHERE id = $1", [
            missionId2,
            { messages, pending: result.pending },
          ]);
          return {
            mission_id: missionId2,
            message: (assistant.content ?? "").trim() || "(awaiting your decision)",
            recommendations: presented,
            purchases,
            permission_request: {
              mission_id: missionId2,
              field: result.pending.field,
              reason: result.pending.reason,
              has_alias: result.pending.has_alias,
            },
          };
        }
        messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: result.content });
      }
    }
  } catch (err) {
    await db.query("UPDATE ghost_missions SET status = 'failed', updated_at = now() WHERE id = $1", [missionId2]);
    throw err;
  }

  // keep a bounded history for follow-ups: the system prompt plus the most recent messages
  const keep = [messages[0]!, ...messages.slice(-19)];
  await db.query("UPDATE ghost_missions SET state = $2, status = 'done', updated_at = now() WHERE id = $1", [
    missionId2,
    { messages: keep, pending: null },
  ]);
  await db.query("INSERT INTO ghost_mission_messages (mission_id, role, content) VALUES ($1, 'assistant', $2)", [
    missionId2,
    reply || "(options shown)",
  ]);

  return {
    mission_id: missionId2,
    message: reply || "(options shown)",
    recommendations: presented,
    purchases,
    permission_request: null,
  };
}

// ---------------------------------------------------------------------------
// Mission reads and the Ghost Receipt

export interface GhostMissionSummary {
  id: string;
  title: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export async function listMissions(vaultId: string, limit = 50): Promise<GhostMissionSummary[]> {
  const { rows } = await db.query<GhostMissionSummary>(
    "SELECT id, title, status, created_at, updated_at FROM ghost_missions WHERE vault_id = $1 ORDER BY created_at DESC LIMIT $2",
    [vaultId, limit],
  );
  return rows;
}

export async function getMission(vaultId: string, id: string) {
  const mission = (
    await db.query<GhostMissionSummary>(
      "SELECT id, title, status, created_at, updated_at FROM ghost_missions WHERE id = $1 AND vault_id = $2",
      [id, vaultId],
    )
  ).rows[0];
  if (!mission) throw notFound("mission");
  const { rows: messages } = await db.query<{ id: number; role: "user" | "assistant"; content: string; created_at: Date }>(
    "SELECT id, role, content, created_at FROM ghost_mission_messages WHERE mission_id = $1 ORDER BY id",
    [id],
  );
  return { ...mission, messages };
}

export interface ReceiptEvent {
  kind: string;
  detail: Record<string, unknown>;
}

export interface GhostReceipt {
  mission_id: string;
  title: string | null;
  status: string;
  created_at: Date;
  sites_visited: string[];
  actions: Record<string, number>;
  permissions: { field: string; decision: "approve" | "alias" | "deny" }[];
  info_shared: { real: string[]; aliased: { field: string; value: string }[] };
  recommendations: GhostRecommendation[];
  purchases: { order_id: string; title: string; price_usd: number }[];
}

/** Pure receipt builder from the event trail — exported for testing without a database. */
export function buildReceipt(
  mission: { id: string; title: string | null; status: string; created_at: Date },
  events: ReceiptEvent[],
): GhostReceipt {
  const sites_visited = [
    ...new Set(events.filter((e) => e.kind === "fetch").map((e) => String(e.detail.url ?? "")).filter(Boolean)),
  ];
  const actions: Record<string, number> = {};
  for (const e of events) actions[e.kind] = (actions[e.kind] ?? 0) + 1;
  const permissions = events
    .filter((e) => e.kind === "permission_grant" || e.kind === "permission_deny")
    .map((e) => ({
      field: String(e.detail.field ?? "unknown"),
      decision: (e.kind === "permission_grant" ? String(e.detail.decision ?? "approve") : "deny") as
        | "approve"
        | "alias"
        | "deny",
    }));
  const info_shared = {
    real: events.filter((e) => e.kind === "data_shared").map((e) => String(e.detail.field)),
    aliased: events
      .filter((e) => e.kind === "alias_used")
      .map((e) => ({ field: String(e.detail.field), value: String(e.detail.value ?? "") })),
  };
  const present = events.filter((e) => e.kind === "present").at(-1);
  const recommendations = present ? ((present.detail.items ?? []) as GhostRecommendation[]) : [];
  const purchases = events
    .filter((e) => e.kind === "purchase")
    .map((e) => ({
      order_id: String(e.detail.order_id ?? ""),
      title: String(e.detail.title ?? ""),
      price_usd: Number(e.detail.price_usd ?? 0),
    }));
  return {
    mission_id: mission.id,
    title: mission.title,
    status: mission.status,
    created_at: mission.created_at,
    sites_visited,
    actions,
    permissions,
    info_shared,
    recommendations,
    purchases,
  };
}

export async function receipt(vaultId: string, id: string): Promise<GhostReceipt> {
  const mission = (
    await db.query<{ id: string; title: string | null; status: string; created_at: Date }>(
      "SELECT id, title, status, created_at FROM ghost_missions WHERE id = $1 AND vault_id = $2",
      [id, vaultId],
    )
  ).rows[0];
  if (!mission) throw notFound("mission");
  const { rows: events } = await db.query<ReceiptEvent>(
    "SELECT kind, detail FROM ghost_mission_events WHERE mission_id = $1 ORDER BY id",
    [id],
  );
  return buildReceipt(mission, events);
}
