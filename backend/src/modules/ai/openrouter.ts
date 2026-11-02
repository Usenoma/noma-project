import { config } from "../../config.js";
import { HttpError } from "../../lib/errors.js";

export interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
}

let modelCache: { at: number; data: OpenRouterModel[] } | undefined;

function authHeaders(): Record<string, string> {
  if (!config.OPENROUTER_API_KEY) throw new HttpError(503, "AI gateway is not configured");
  return {
    Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
    // OpenRouter asks apps to identify themselves.
    "HTTP-Referer": config.AI_PUBLIC_BASE_URL,
    "X-Title": "NOMA AI",
  };
}

const base = () => config.OPENROUTER_BASE_URL.replace(/\/$/, "");

export async function openRouterModels(): Promise<OpenRouterModel[]> {
  if (modelCache && Date.now() - modelCache.at < 10 * 60_000) return modelCache.data;
  const res = await fetch(`${base()}/models`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new HttpError(503, `OpenRouter models unavailable (${res.status})`);
  const body = (await res.json()) as { data?: OpenRouterModel[] };
  const data = body.data ?? [];
  modelCache = { at: Date.now(), data };
  return data;
}

export async function modelPricing(model: string): Promise<{ prompt: number; completion: number }> {
  const found = (await openRouterModels()).find((m) => m.id === model);
  if (!found) throw new HttpError(400, `unknown model: ${model}`);
  const prompt = Number(found.pricing?.prompt ?? 0);
  const completion = Number(found.pricing?.completion ?? 0);
  if (!(prompt > 0) || !(completion >= 0)) throw new HttpError(503, `pricing unavailable for ${model}`);
  return { prompt, completion };
}

/** Available OpenRouter credit in USD (platform float for the gateway). */
export async function credits(): Promise<number> {
  const res = await fetch(`${base()}/credits`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`openrouter credits ${res.status}`);
  const body = (await res.json()) as { data?: { total_credits?: number; total_usage?: number } };
  return Number(body.data?.total_credits ?? 0) - Number(body.data?.total_usage ?? 0);
}

/** Exact upstream cost for a generation; null when the endpoint does not answer. */
export async function generationCost(generationId: string | null): Promise<number | null> {
  if (!generationId) return null;
  try {
    const res = await fetch(`${base()}/generation?id=${encodeURIComponent(generationId)}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { total_cost?: number } };
    const cost = body.data?.total_cost;
    return typeof cost === "number" && Number.isFinite(cost) ? cost : null;
  } catch {
    return null;
  }
}

/** Proxy a chat completion request to OpenRouter. Non-2xx responses are returned for the route to handle. */
export async function chatCompletion(body: Record<string, unknown>, stream: boolean): Promise<Response> {
  const payload = {
    ...body,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
  return fetch(`${base()}/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300_000),
  });
}
