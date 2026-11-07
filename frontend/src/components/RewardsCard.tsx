"use client";

import useSWR from "swr";
import Link from "next/link";
import { getRewardsCurrent } from "@/lib/api";
import { amount, fromRaw, relativeTime, usd } from "@/lib/format";
import { Countdown } from "./Countdown";

// The live board: indexed on-chain figures, read as a numbered strip rather than a card.
export function RewardsCard() {
  const { data, error } = useSWR("rewards/current", getRewardsCurrent, {
    refreshInterval: 30_000,
  });

  const figures: { label: string; node: React.ReactNode }[] = [
    {
      label: "stock of the week",
      node: data?.cycle ? (
        <span className="text-accent">{data.cycle.stock_of_the_week.symbol}</span>
      ) : (
        <span>—</span>
      ),
    },
    {
      label: "next distribution",
      node: data?.cycle ? <Countdown to={data.cycle.next_distribution_at} /> : <span>—</span>,
    },
    { label: "zec pool", node: <span>{data?.pools ? usd(data.pools.zec_pool.usd) : "—"}</span> },
    {
      label: "stock pool",
      node: <span>{data?.pools ? usd(data.pools.stock_pool.usd) : "—"}</span>,
    },
    {
      label: "total staked",
      node: (
        <span>
          {data?.total_staked ? `${amount(fromRaw(data.total_staked, 18, 0))} NOMA` : "—"}
        </span>
      ),
    },
  ];

  return (
    <section aria-label="This week's rewards" className="border-y border-line py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-[0.62rem] tracking-[0.16em] text-ink-dim uppercase">
          this week&apos;s rewards
        </span>
        {data?.pools ? (
          <span className="font-mono text-[0.6rem] text-ink-dim">
            updated {relativeTime(data.pools.updated_at)}
          </span>
        ) : null}
      </div>
      {error ? (
        <p className="mt-4 text-sm text-ink-dim">reward data unavailable</p>
      ) : !data ? (
        <p className="mt-4 text-sm text-ink-dim">reading the chain…</p>
      ) : (
        <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-5">
          {figures.map((figure) => (
            <div key={figure.label}>
              <div className="font-mono text-[0.6rem] tracking-[0.16em] text-ink-dim uppercase">
                {figure.label}
              </div>
              <div className="tnum mt-2 text-xl font-medium tracking-tight sm:text-2xl">
                {figure.node}
              </div>
            </div>
          ))}
        </div>
      )}
      <Link
        href="/rewards"
        className="mt-5 inline-flex min-h-11 items-center font-mono text-[0.66rem] tracking-[0.16em] text-accent uppercase hover:underline"
      >
        reward engine →
      </Link>
    </section>
  );
}
