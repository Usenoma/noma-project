"use client";

import useSWR from "swr";
import { getCollection } from "@/lib/api";
import { amount, dateTime, shortAddress, usd } from "@/lib/format";
import { EmptyState } from "./EmptyState";
import { TxLink } from "./TxLink";

export function CollectionView({ address }: { address: string }) {
  const { data, error } = useSWR(["collection", address], () => getCollection(address));

  if (error) {
    return <EmptyState line="no collection for this address" action={{ href: "/lookup", label: "wallet lookup" }} />;
  }
  if (!data) {
    return <p className="font-mono text-sm text-ink-dim">loading collection…</p>;
  }

  const totals = Object.entries(data.usd_totals);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <div className="rule-label">collection</div>
        <div className="mt-3 flex flex-wrap items-baseline gap-4">
          <h1 className="tnum font-mono text-2xl">{shortAddress(data.address)}</h1>
          {data.genesis ? (
            <span className="border border-accent px-2 py-0.5 font-mono text-xs text-accent">
              GENESIS · week 1
            </span>
          ) : null}
        </div>
        <p className="mt-1 font-mono text-xs text-ink-dim">
          {data.companies_count} {data.companies_count === 1 ? "company" : "companies"} · every entry
          provable by tx hash
        </p>
      </div>

      {totals.length > 0 ? (
        <div className="flex flex-wrap gap-px border border-line bg-line">
          {totals.map(([asset, total]) => (
            <div key={asset} className="bg-bg-raised px-4 py-3">
              <div className="font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
                {asset}
              </div>
              <div className="tnum mt-1 font-mono text-lg">{usd(total)}</div>
            </div>
          ))}
        </div>
      ) : null}

      <div>
        <div className="mb-2 font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
          rewards received
        </div>
        {data.entries.length === 0 ? (
          <p className="font-mono text-sm text-ink-dim">no rewards yet</p>
        ) : (
          <div className="divide-y divide-line border border-line">
            {data.entries.map((e, i) => (
              <div key={i} className="flex flex-wrap items-baseline gap-x-4 px-4 py-2.5 font-mono text-sm">
                <span className="tnum text-ink-dim">week {e.week_no}</span>
                <span className="text-ink">{e.asset_symbol} ✓</span>
                <span className="tnum">{amount(e.amount)}</span>
                {e.usd_value ? <span className="tnum text-ink-dim">{usd(e.usd_value)}</span> : null}
                <span className="ml-auto">
                  <TxLink hash={e.tx_hash} />
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {data.claims.length > 0 ? (
        <div>
          <div className="mb-2 font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
            claims
          </div>
          <div className="divide-y divide-line border border-line">
            {data.claims.map((c, i) => (
              <div key={i} className="flex flex-wrap items-baseline gap-x-4 px-4 py-2.5 font-mono text-sm">
                <span className="text-ink">{c.asset}</span>
                <span className="tnum">{amount(c.amount)}</span>
                {c.amount_usd ? <span className="tnum text-ink-dim">{usd(c.amount_usd)}</span> : null}
                <span className="tnum text-xs text-ink-dim">{dateTime(c.ts)}</span>
                <span className="ml-auto">
                  <TxLink hash={c.tx_hash} />
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
