import type { Category } from "../../suppliers/types.js";

/** Markup config: a default plus optional per-category overrides, e.g. { default: 0.08, esim: 0.12 }. */
export type MarkupConfig = { default: number } & Partial<Record<Category, number>>;

export function applyMarkup(costUsd: number, category: Category, markup: MarkupConfig): number {
  const pct = markup[category] ?? markup.default;
  // round up to the cent so we never sell below cost + markup; the inner round strips float noise
  // (10 * 1.12 = 11.200000000000001 must price at 11.20, not 11.21)
  return Math.ceil(Math.round(costUsd * (1 + pct) * 1e6) / 1e4) / 100;
}
