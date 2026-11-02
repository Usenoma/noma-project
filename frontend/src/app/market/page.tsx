import { Suspense } from "react";
import type { Metadata } from "next";
import { MarketBrowser } from "@/components/MarketBrowser";

export const metadata: Metadata = { title: "Market" };

export default function MarketPage() {
  return (
    <div>
      <div className="mb-10">
        <div className="rule-label">§01 — the market</div>
        <h1 className="mt-4 text-4xl tracking-[-0.045em] sm:text-5xl xl:text-6xl">Market</h1>
        <p className="mt-3 max-w-xl text-base text-ink-dim">
          One product per order. Checkout is immediate, and every price is locked at invoice time.
        </p>
      </div>
      <Suspense fallback={<p className="font-mono text-sm text-ink-dim">loading catalog…</p>}>
        <MarketBrowser />
      </Suspense>
    </div>
  );
}
