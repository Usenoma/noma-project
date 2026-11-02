import { z } from "zod";
import { config } from "../../config.js";
import { db } from "../../db/pool.js";
import { HttpError } from "../../lib/errors.js";
import { getProducts, listProducts, type Product } from "../catalog/service.js";

const SYSTEM_PROMPT = `You are the NOMA shopping assistant. NOMA sells digital services for crypto with no accounts:
eSIMs, AI credits, VPS/compute and gift cards / digital credits.

Help the user find the right product from NOMA's own catalog:
- Use search_catalog to find candidates and compare_products when the user needs a side-by-side view.
- Recommend only products returned by these tools. Never invent products, prices or specs.
- When you have options for the user, call present_options with up to 5 product ids, best match first.
  The app renders them as selectable cards; the user picks one and checks out themselves.
- You cannot buy anything or take payment. If asked, explain that the user completes checkout.
- If nothing fits, say so and suggest the closest alternatives.
Keep replies short.`;

const CATEGORIES = ["esim", "ai_credits", "vps", "giftcard"] as const;

const searchInput = z.object({
  category: z.enum(CATEGORIES).optional(),
  region: z.string().optional(),
  query: z.string().optional(),
  min_data_gb: z.number().optional(),
  max_price: z.number().optional(),
  specs: z.record(z.number()).optional(),
});
const idsInput = z.object({ product_ids: z.array(z.string().uuid()).min(1).max(10) });
const presentInput = z.object({ product_ids: z.array(z.string().uuid()).min(1).max(5) });

const toCard = (p: Product) => ({
  product_id: p.id,
  category: p.category,
  title: p.title,
  region: p.region,
  price_usd: p.price_usd,
  specs: p.specs,
});

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

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_catalog",
      description:
        "Search NOMA's catalog. Filter by category, ISO country code region (e.g. JP), free-text query, " +
        "minimum data in GB (eSIM), maximum price in USD, and minimum numeric spec values (e.g. {\"ram_gb\": 4}). " +
        "Returns up to 20 products sorted by price ascending.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", enum: [...CATEGORIES] },
          region: { type: "string", description: "ISO 3166-1 alpha-2 country code" },
          query: { type: "string" },
          min_data_gb: { type: "number" },
          max_price: { type: "number", description: "USD" },
          specs: { type: "object", additionalProperties: { type: "number" } },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_products",
      description: "Get full details of specific products by id for a side-by-side comparison.",
      parameters: {
        type: "object",
        properties: {
          product_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
        },
        required: ["product_ids"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "present_options",
      description: "Show the user selectable product cards, best match first. Call once when you have recommendations.",
      parameters: {
        type: "object",
        properties: {
          product_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
        },
        required: ["product_ids"],
        additionalProperties: false,
      },
    },
  },
];

async function runTool(name: string, raw: unknown, setPresented: (p: Product[]) => void): Promise<string> {
  switch (name) {
    case "search_catalog": {
      const input = searchInput.parse(raw);
      const specs = {
        ...input.specs,
        ...(input.min_data_gb !== undefined ? { data_gb: input.min_data_gb } : {}),
      };
      const products = await listProducts({
        category: input.category,
        region: input.region,
        q: input.query,
        maxPrice: input.max_price,
        specs,
        limit: 20,
      });
      return JSON.stringify(products.map(toCard));
    }
    case "compare_products": {
      const { product_ids } = idsInput.parse(raw);
      return JSON.stringify((await getProducts(product_ids)).map(toCard));
    }
    case "present_options": {
      const { product_ids } = presentInput.parse(raw);
      const found = await getProducts(product_ids);
      const ordered = product_ids.map((id) => found.find((p) => p.id === id)).filter((p): p is Product => !!p);
      setPresented(ordered);
      return `Presented ${ordered.length} option(s) to the user.`;
    }
    default:
      return JSON.stringify({ error: `unknown tool: ${name}` });
  }
}

export interface AgentReply {
  session_id: string;
  message: string;
  options: ReturnType<typeof toCard>[];
}

export async function chat(sessionId: string | undefined, message: string): Promise<AgentReply> {
  const apiKey = config.LLM_API_KEY ?? config.OPENROUTER_API_KEY;
  if (!apiKey) throw new HttpError(503, "agent not configured");
  const base = (config.LLM_BASE_URL ?? config.OPENROUTER_BASE_URL).replace(/\/$/, "");

  const known = sessionId ? (await db.query("SELECT 1 FROM agent_sessions WHERE id = $1", [sessionId])).rowCount : 0;
  const session = known
    ? sessionId!
    : (await db.query<{ id: string }>("INSERT INTO agent_sessions DEFAULT VALUES RETURNING id")).rows[0]!.id;
  const { rows: history } = await db.query<{ role: "user" | "assistant"; content: string }>(
    `SELECT role, content FROM (
       SELECT role, content, id FROM agent_messages WHERE session_id = $1 ORDER BY id DESC LIMIT 20
     ) h ORDER BY id`,
    [session],
  );

  let presented: Product[] = [];
  let reply = "";
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((m): ChatMessage =>
      m.role === "assistant"
        ? { role: "assistant", content: m.content }
        : { role: "user", content: m.content },
    ),
    { role: "user", content: message },
  ];

  for (let turn = 0; turn < 6; turn++) {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": config.AI_PUBLIC_BASE_URL,
        "X-Title": "NOMA Agent",
      },
      body: JSON.stringify({
        model: config.LLM_MODEL,
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
      throw new HttpError(502, `agent upstream ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { choices?: { message?: UpstreamMessage }[] };
    const assistant = data.choices?.[0]?.message;
    if (!assistant) throw new HttpError(502, "agent upstream returned no message");

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
      let content: string;
      try {
        content = await runTool(call.function.name, JSON.parse(call.function.arguments || "{}"), (p) => {
          presented = p;
        });
      } catch (err) {
        content = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content });
    }
  }

  await db.query("INSERT INTO agent_messages (session_id, role, content) VALUES ($1, 'user', $2), ($1, 'assistant', $3)", [
    session,
    message,
    reply || "(options shown)",
  ]);

  return { session_id: session, message: reply || "(options shown)", options: presented.map(toCard) };
}
