"use client";

import { useState } from "react";
import Link from "next/link";
import { getLookup } from "@/lib/api";
import { amount, dateTime, fromRaw, usd } from "@/lib/format";
import type { LookupResult } from "@/lib/types";
import { Countdown } from "./Countdown";
import { Stat } from "./Stat";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function LookupView() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const addr = input.trim();
    if (!ADDRESS_RE.test(addr)) {
      setError("not a valid address — expected 0x followed by 40 hex characters");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await getLookup(addr));
    } catch (err) {
      setError(err instanceof Error ? err.message : "lookup failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <div>
        <div className="rule-label">wallet lookup</div>
        <h1 className="mt-4 text-4xl tracking-[-0.045em] sm:text-5xl xl:text-6xl">Wallet Lookup</h1>
        <p className="mt-3 text-base text-ink-dim">
          Paste a public address. No connect, no signature.
        </p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-2">
        <label htmlFor="lookup-address" className="field-label">
          wallet address
        </label>
        <div className="flex gap-2">
          <input
            id="lookup-address"
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
            className="field tnum min-w-0 flex-1"
          />
          <button type="submit" disabled={loading} className="btn">
            {loading ? "looking up…" : "look up"}
          </button>
        </div>
      </form>

      {error ? <p className="font-mono text-sm text-bad">{error}</p> : null}

      {result ? (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-px border border-line bg-line lg:grid-cols-4">
            <Stat label="staked" value={`${amount(fromRaw(result.staked, 18, 2))} NOMA`} />
            <Stat
              label="pending unstake"
              value={
                parseFloat(result.pending_unstake) > 0
                  ? `${amount(fromRaw(result.pending_unstake, 18, 2))} NOMA`
                  : "0"
              }
              caption={result.unlock_at ? `unlocks ${dateTime(result.unlock_at)}` : undefined}
            />
            <Stat label="total claimed" value={usd(result.total_claimed_usd)} />
            <div className="bg-bg px-4 py-4">
              <div className="font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
                status
              </div>
              <div className="mt-1 font-mono text-xl">
                {result.genesis ? (
                  <span className="text-accent">GENESIS · week 1</span>
                ) : result.eligible ? (
                  <span className="text-good">earning</span>
                ) : (
                  <span className="text-ink-dim">not staked</span>
                )}
              </div>
              {result.next_distribution_at ? (
                <div className="mt-1 font-mono text-[0.7rem] text-ink-dim">
                  next distribution <Countdown to={result.next_distribution_at} />
                </div>
              ) : null}
            </div>
          </div>

          {result.claimable.length > 0 ? (
            <div className="border border-line">
              <div className="border-b border-line px-4 py-2 font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
                claimable now
              </div>
              <div className="divide-y divide-line">
                {result.claimable.map((c) => (
                  <div key={c.asset} className="flex items-baseline justify-between px-4 py-2.5">
                    <span className="font-mono text-sm">{c.asset}</span>
                    <span className="tnum font-mono text-sm">
                      {amount(c.amount)}
                      {c.usd ? <span className="text-ink-dim"> · {usd(c.usd)}</span> : null}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <Link
            href={`/collection/${result.address}`}
            className="font-mono text-sm text-accent hover:underline"
          >
            view collection →
          </Link>
        </div>
      ) : null}
    </div>
  );
}
