"use client";

import useSWR from "swr";
import Link from "next/link";
import { getCatalog } from "@/lib/api";
import { categoryLabel, usd } from "@/lib/format";
import type { Category } from "@/lib/types";

const CATEGORIES: Category[] = ["esim", "ai_credits", "vps", "giftcard"];

export function CategoryIndex() {
  // The catalog endpoint caps its list, so a total count would be a lie. Each row shows the
  // real cheapest price for its category instead (sorted ascending, first product).
  const { data } = useSWR(
    "catalog/tiles",
    async () => {
      const results = await Promise.all(
        CATEGORIES.map((c) => getCatalog({ category: c, sort: "price_asc" })),
      );
      return new Map<Category, string | null>(
        CATEGORIES.map((c, i) => [c, results[i]?.products.find((p) => p.available)?.price_usd ?? null]),
      );
    },
    { refreshInterval: 60_000 },
  );

  return (
    <div className="border-t border-line">
      {CATEGORIES.map((category, index) => {
        const from = data?.get(category) ?? null;
        return (
          <Link
            key={category}
            href={`/market?category=${category}`}
            className="group grid grid-cols-[2rem_1fr] items-baseline gap-x-3 gap-y-2 border-b border-line px-1 py-5 transition-colors hover:bg-bg-raised sm:grid-cols-[2.5rem_1fr_auto] sm:items-center sm:px-4 sm:py-6"
          >
            <span className="tnum font-mono text-[0.62rem] tracking-[0.16em] text-ink-dim">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="display text-3xl leading-none tracking-[-0.04em] transition-transform duration-500 group-hover:translate-x-1.5 sm:text-5xl xl:text-6xl">
              {categoryLabel(category)}
            </span>
            <span className="col-start-2 flex items-baseline justify-between gap-6 sm:col-start-3 sm:justify-end">
              <span className="tnum font-mono text-xs text-ink-dim transition-colors group-hover:text-ink">
                {from ? `from ${usd(from)}` : "—"}
              </span>
              <span
                className="font-mono text-sm text-ink-dim transition-all duration-300 group-hover:translate-x-1 group-hover:text-accent"
                aria-hidden
              >
                →
              </span>
            </span>
          </Link>
        );
      })}
    </div>
  );
}
