import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { z } from "zod";
import { config } from "../../config.js";
import { db } from "../../db/pool.js";
import { HttpError } from "../../lib/errors.js";
import { getProducts, listProducts, type Product } from "../catalog/service.js";

const SYSTEM_PROMPT = `You are the NOMA shopping assistant. NOMA sells digital services for crypto with no accounts:
eSIMs, AI credits, VPN, proxies, VPS/compute and gift cards / digital credits.

Help the user find the right product from NOMA's own catalog:
- Use search_catalog to find candidates and compare_products when the user needs a side-by-side view.
- Recommend only products returned by these tools. Never invent products, prices or specs.
- When you have options for the user, call present_options with up to 5 product ids, best match first.
  The app renders them as selectable cards; the user picks one and checks out themselves.
- You cannot buy anything or take payment. If asked, explain that the user completes checkout.
- If nothing fits, say so and suggest the closest alternatives.
Keep replies short.`;

const CATEGORIES = ["esim", "ai_credits", "vpn", "proxy", "vps", "giftcard"] as const;

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

let client: Anthropic | undefined;
const anthropic = () => (client ??= new Anthropic({ apiKey: config.LLM_API_KEY }));

export interface AgentReply {
  session_id: string;
  message: string;
  options: ReturnType<typeof toCard>[];
}

export async function chat(sessionId: string | undefined, message: string): Promise<AgentReply> {
  if (!config.LLM_API_KEY) throw new HttpError(503, "agent not configured");

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

  const tools = [
    betaTool({
      name: "search_catalog",
      description:
        "Search NOMA's catalog. Filter by category, ISO country code region (e.g. JP), free-text query, " +
        "minimum data in GB (eSIM), maximum price in USD, and minimum numeric spec values (e.g. {\"ram_gb\": 4}). " +
        "Returns up to 20 products sorted by price ascending.",
      inputSchema: {
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
      run: async (raw) => {
        const input = searchInput.parse(raw);
        const specs = { ...input.specs, ...(input.min_data_gb !== undefined ? { data_gb: input.min_data_gb } : {}) };
        const products = await listProducts({
          category: input.category,
          region: input.region,
          q: input.query,
          maxPrice: input.max_price,
          specs,
          limit: 20,
        });
        return JSON.stringify(products.map(toCard));
      },
    }),
    betaTool({
      name: "compare_products",
      description: "Get full details of specific products by id for a side-by-side comparison.",
      inputSchema: {
        type: "object",
        properties: { product_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 } },
        required: ["product_ids"],
        additionalProperties: false,
      },
      run: async (raw) => {
        const { product_ids } = idsInput.parse(raw);
        return JSON.stringify((await getProducts(product_ids)).map(toCard));
      },
    }),
    betaTool({
      name: "present_options",
      description: "Show the user selectable product cards, best match first. Call once when you have recommendations.",
      inputSchema: {
        type: "object",
        properties: { product_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 } },
        required: ["product_ids"],
        additionalProperties: false,
      },
      run: async (raw) => {
        const { product_ids } = presentInput.parse(raw);
        const found = await getProducts(product_ids);
        // keep the model's ranking; drop anything not in the active catalog
        presented = product_ids.map((id) => found.find((p) => p.id === id)).filter((p): p is Product => !!p);
        return `Presented ${presented.length} option(s) to the user.`;
      },
    }),
  ];

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: message },
  ];

  const final = await anthropic().beta.messages.toolRunner({
    model: config.LLM_MODEL,
    max_tokens: 16000,
    max_iterations: 8,
    // shopping chat is latency-sensitive and simple; low effort keeps replies fast
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM_PROMPT,
    tools,
    messages,
  });

  const reply =
    final.stop_reason === "refusal"
      ? "Sorry, I can't help with that. I can help you find eSIMs, AI credits, VPN, proxies, VPS or gift cards."
      : final.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();

  await db.query("INSERT INTO agent_messages (session_id, role, content) VALUES ($1, 'user', $2), ($1, 'assistant', $3)", [
    session,
    message,
    reply || "(options shown)",
  ]);

  return { session_id: session, message: reply, options: presented.map(toCard) };
}
