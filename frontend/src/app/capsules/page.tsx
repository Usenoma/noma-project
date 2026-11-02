"use client";

import useSWR from "swr";
import Link from "next/link";
import { getCapsules } from "@/lib/api";
import { FEATURES } from "@/lib/features";
import { usd } from "@/lib/format";
import { EmptyState } from "@/components/EmptyState";
import { SectionHead } from "@/components/SectionHead";

export default function CapsulesPage() {
  const { data, error } = useSWR(FEATURES.capsules ? "capsules" : null, getCapsules);

  if (!FEATURES.capsules) {
    return <EmptyState line="capsules are not available yet" action={{ href: "/market", label: "browse the market" }} />;
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <div className="rule-label">§01 — capsules</div>
        <h1 className="mt-3 text-3xl font-medium tracking-tight">Digital Capsules</h1>
        <p className="mt-2 max-w-xl text-sm text-ink-dim">
          Buy the outcome, not the checklist. Each capsule bundles the services one goal needs, priced
          from the cheapest live product per item.
        </p>
      </div>

      {error ? (
        <EmptyState line="capsules unavailable — try again shortly" />
      ) : !data ? (
        <p className="font-mono text-sm text-ink-dim">loading capsules…</p>
      ) : data.capsules.length === 0 ? (
        <EmptyState line="no capsules yet" />
      ) : (
        <div className="grid gap-px border border-line bg-line sm:grid-cols-2">
          {data.capsules.map((c) => (
            <Link key={c.slug} href={`/capsules/${c.slug}`} className="bg-bg-raised p-5 hover:bg-bg">
              <div className="flex items-baseline justify-between">
                <h2 className="text-lg font-medium">{c.title}</h2>
                <span className="tnum font-mono text-sm text-accent">{usd(c.total_usd)}</span>
              </div>
              <p className="mt-2 text-sm text-ink-dim">{c.outcome}</p>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-ink-dim">
                {c.items.map((i) => (
                  <span key={i.category}>{i.title}</span>
                ))}
              </div>
              {!c.available ? (
                <p className="mt-2 font-mono text-xs text-warn">one item is unavailable right now</p>
              ) : null}
            </Link>
          ))}
        </div>
      )}

      <SectionHead num="02" title="How a capsule works" />
      <div className="border border-line bg-bg-raised p-5 text-sm text-ink-dim">
        <p>
          One click creates one order per included service. Each order carries its own invoice; an item
          that fails refunds only that item and the rest of the capsule stands.
        </p>
      </div>
    </div>
  );
}
