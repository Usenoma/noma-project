import { getSetting } from "../../db/pool.js";
import type { MarkupConfig } from "../catalog/pricing.js";

export const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
export const round8 = (n: number) => Math.round(n * 1e8) / 1e8;

let cached: { at: number; pct: number } | undefined;

/** The catalog markup, including an optional ai_credits override. Cached briefly. */
export async function aiMarkup(): Promise<number> {
  if (cached && Date.now() - cached.at < 60_000) return cached.pct;
  const m = (await getSetting<MarkupConfig>("markup_pct")) ?? { default: 0.08 };
  const pct = m.ai_credits ?? m.default;
  cached = { at: Date.now(), pct };
  return pct;
}

/** What the buyer is charged for an upstream cost: OpenRouter cost + the platform fee. */
export function retailCost(openrouterCost: number, markup: number): number {
  return round8(openrouterCost * (1 + markup));
}

/** Conservative pre-authorization before the upstream call. */
export function reserveUsd(
  promptTokens: number,
  maxTokens: number,
  promptPrice: number,
  completionPrice: number,
  markup: number,
  safety: number,
): number {
  const cost = promptTokens * promptPrice + maxTokens * completionPrice;
  return round8(cost * (1 + markup) * safety);
}

/** Rough token estimate for the reserve; the actual usage always comes from OpenRouter. */
export function estimatePromptTokens(messages: unknown, tools?: unknown): number {
  return Math.ceil(JSON.stringify({ messages, tools }).length / 4) + 16;
}

/** Fallback when the generation endpoint does not return a cost. */
export function costFromUsage(
  usage: { prompt_tokens?: number; completion_tokens?: number } | null | undefined,
  promptPrice: number,
  completionPrice: number,
): number {
  return round8((usage?.prompt_tokens ?? 0) * promptPrice + (usage?.completion_tokens ?? 0) * completionPrice);
}
