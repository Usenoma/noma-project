"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { getCatalog, getCatalogFacets } from "@/lib/api";
import { categoryLabel } from "@/lib/format";
import type { Category, Product } from "@/lib/types";
import { EmptyState } from "./EmptyState";
import { ProductRow } from "./ProductRow";

const CATEGORIES: (Category | "")[] = ["", "esim", "ai_credits", "vps", "giftcard"];
const PAGE_SIZE = 20;

type Sort = "price_asc" | "price_desc" | "title";

export function MarketBrowser() {
  const router = useRouter();
  const params = useSearchParams();

  const category = (params.get("category") ?? "") as Category | "";
  const q = params.get("q") ?? "";
  const region = params.get("region") ?? "";
  const sort = (params.get("sort") ?? "price_asc") as Sort;
  const page = Math.max(1, parseInt(params.get("page") ?? "1", 10) || 1);

  const [searchInput, setSearchInput] = useState(q);
  const offset = (page - 1) * PAGE_SIZE;

  const { data, error } = useSWR(
    ["catalog", category, q, region, sort, page],
    () =>
      getCatalog({
        category: category || undefined,
        q: q || undefined,
        region: region || undefined,
        sort,
        limit: PAGE_SIZE,
        offset,
      }),
    { refreshInterval: 60_000 },
  );

  const products = data?.products ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageProducts = products;

  // Region counts across the whole filtered catalog, not just the visible page.
  const { data: facets } = useSWR(
    ["catalog-facets", category, q],
    () => getCatalogFacets({ category: category || undefined, q: q || undefined }),
    { refreshInterval: 60_000 },
  );
  const regions = useMemo(
    () => (facets?.regions ?? []).map((r) => [r.region, r.count] as [string, number]),
    [facets],
  );

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    router.push(`/market?${next.toString()}`);
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    setParam("q", searchInput.trim());
  }

  const regionPanel =
    regions.length > 0 ? (
      <div>
        <div className="mb-2 font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
          region
        </div>
        <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
          <button
            type="button"
            onClick={() => setParam("region", "")}
            className={`flex min-h-11 items-center border-l py-1.5 pr-2 pl-3 text-left font-mono text-sm transition-colors lg:min-h-0 ${
              !region ? "border-accent text-accent" : "border-transparent text-ink-dim hover:text-ink"
            }`}
          >
            all regions
          </button>
          {regions.map(([r, count]) => (
            <button
              key={r}
              type="button"
              onClick={() => setParam("region", r)}
              className={`flex min-h-11 items-center justify-between border-l py-1.5 pr-2 pl-3 text-left font-mono text-sm transition-colors lg:min-h-0 ${
                region === r
                  ? "border-accent text-accent"
                  : "border-transparent text-ink-dim hover:text-ink"
              }`}
            >
              <span>{r}</span>
              <span className="tnum text-ink-dim">{count}</span>
            </button>
          ))}
        </div>
      </div>
    ) : null;

  const sortPanel = (
    <div>
      <div className="mb-2 font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
        sort
      </div>
      <div className="flex flex-col gap-1">
        {(
          [
            ["price_asc", "price ↑"],
            ["price_desc", "price ↓"],
            ["title", "title a–z"],
          ] as [Sort, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setParam("sort", value)}
            className={`flex min-h-11 items-center border-l py-1.5 pr-2 pl-3 text-left font-mono text-sm transition-colors lg:min-h-0 ${
              sort === value
                ? "border-accent text-accent"
                : "border-transparent text-ink-dim hover:text-ink"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="grid gap-8 lg:grid-cols-[220px_1fr]">
      {/* Facet rail — chips and a disclosure on phones, a full rail from lg. */}
      <aside className="flex min-w-0 flex-col gap-5 lg:sticky lg:top-24 lg:gap-6 lg:self-start">
        <form onSubmit={submitSearch}>
          <label
            htmlFor="market-search"
            className="mb-2 block font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase"
          >
            search
          </label>
          <input
            id="market-search"
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="japan 20gb…"
            className="field"
          />
        </form>

        <div>
          <div className="mb-2 hidden font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase lg:block">
            category
          </div>
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6 lg:mx-0 lg:flex-col lg:gap-1 lg:overflow-visible lg:px-0 lg:pb-0">
            {CATEGORIES.map((c) => {
              const active = category === c;
              return (
                <button
                  key={c || "all"}
                  type="button"
                  onClick={() => setParam("category", c)}
                  className={`flex min-h-11 shrink-0 items-center whitespace-nowrap border-b-2 px-3 py-2 text-left font-mono text-sm transition-colors lg:min-h-0 lg:border-b-0 lg:border-l lg:py-1.5 lg:pr-2 lg:pl-3 ${
                    active
                      ? "border-accent text-accent"
                      : "border-transparent text-ink-dim hover:text-ink"
                  }`}
                >
                  {c ? categoryLabel(c) : "all"}
                </button>
              );
            })}
          </div>
        </div>

        <details className="border-y border-line py-1 lg:hidden">
          <summary className="flex min-h-11 cursor-pointer items-center font-mono text-[0.68rem] tracking-[0.16em] text-ink-dim uppercase marker:text-accent">
            filters · region &amp; sort
          </summary>
          <div className="flex flex-col gap-5 pb-4">
            {regionPanel}
            {sortPanel}
          </div>
        </details>

        <div className="hidden lg:block">{regionPanel}</div>
        <div className="hidden lg:block">{sortPanel}</div>
      </aside>

      {/* Results */}
      <div className="min-w-0">
        {error ? (
          <EmptyState line="catalog unavailable — try again shortly" />
        ) : !data ? (
          <CatalogSkeleton />
        ) : pageProducts.length === 0 ? (
          <EmptyState
            line={q ? `no results for "${q}"` : "no products in this category right now"}
            action={q ? { href: "/market", label: "clear search" } : undefined}
          />
        ) : (
          <>
            <div className="mb-2 flex items-baseline justify-between font-mono text-[0.7rem] text-ink-dim">
              <span className="tnum">
                {total} product{total === 1 ? "" : "s"}
              </span>
              <span className="tnum">
                page {page} / {totalPages}
              </span>
            </div>
            <div className="divide-y divide-line border-y border-line">
              {pageProducts.map((p: Product) => (
                <ProductRow key={p.id} product={p} />
              ))}
            </div>
            {totalPages > 1 ? (
              <div className="mt-5 flex items-center gap-4 font-mono text-sm">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setParam("page", String(page - 1))}
                  className="inline-flex min-h-11 items-center border border-line px-4 text-ink-dim transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
                >
                  ← prev
                </button>
                <span className="tnum text-ink-dim">
                  {page} / {totalPages}
                </span>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setParam("page", String(page + 1))}
                  className="inline-flex min-h-11 items-center border border-line px-4 text-ink-dim transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
                >
                  next →
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function CatalogSkeleton() {
  return (
    <div className="divide-y divide-line border-y border-line">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center justify-between px-4 py-4">
          <div className="h-4 w-1/2 animate-pulse bg-line" />
          <div className="h-4 w-16 animate-pulse bg-line" />
        </div>
      ))}
    </div>
  );
}
