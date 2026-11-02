"use client";

import useSWR from "swr";
import {
  getMethodology,
  getRewardsCurrent,
  getRewardsHistory,
  getRewardsTransactions,
} from "@/lib/api";
import { amount, dateOnly, dateTime, fromRaw, relativeTime, secondsToDays, usd } from "@/lib/format";
import { Countdown } from "./Countdown";
import { SectionHead } from "./SectionHead";
import { Stat } from "./Stat";
import { StakingPanel } from "./StakingPanel";
import { StreamBar } from "./StreamBar";
import { TxLink } from "./TxLink";

export function RewardsView() {
  const { data: current } = useSWR("rewards/current", getRewardsCurrent, { refreshInterval: 30_000 });
  const { data: history } = useSWR("rewards/history", getRewardsHistory, { refreshInterval: 60_000 });
  const { data: txs } = useSWR("rewards/txs", () => getRewardsTransactions(50), {
    refreshInterval: 60_000,
  });
  const { data: methodology } = useSWR("rewards/methodology", getMethodology);

  const cycle = current?.cycle ?? null;
  const pools = current?.pools ?? null;

  return (
    <div className="flex flex-col gap-14">
      <div>
        <div className="rule-label">reward engine · live</div>
        <h1 className="mt-4 text-4xl tracking-[-0.045em] sm:text-5xl xl:text-6xl">Reward Engine</h1>
        <p className="mt-3 max-w-xl text-base text-ink-dim">
          Every number below is indexed from on-chain data. Nothing is simulated.
        </p>
      </div>

      {/* Live stats */}
      <div className="grid grid-cols-2 gap-px border border-line bg-line lg:grid-cols-4">
        <Stat
          label="zec pool"
          value={pools ? usd(pools.zec_pool.usd) : "—"}
          caption={pools ? `${amount(pools.zec_pool.amount)} ${pools.quote_asset}` : undefined}
        />
        <Stat
          label="stock pool"
          value={pools ? usd(pools.stock_pool.usd) : "—"}
          caption={pools ? `${amount(pools.stock_pool.amount)} ${pools.quote_asset}` : undefined}
        />
        <Stat
          label="total staked"
          value={current ? `${amount(fromRaw(current.total_staked, 18, 0))} NOMA` : "—"}
        />
        <div className="bg-bg px-4 py-4">
          <div className="font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
            next distribution
          </div>
          <div className="mt-2 font-mono text-xl">
            {cycle ? <Countdown to={cycle.next_distribution_at} /> : "—"}
          </div>
          {pools ? (
            <div className="mt-1 font-mono text-[0.7rem] text-ink-dim">
              updated {relativeTime(pools.updated_at)}
            </div>
          ) : null}
        </div>
      </div>

      {/* §01 — This week */}
      <section>
        <SectionHead num="01" title="This week" />
        {cycle ? (
          <div className="border border-line bg-bg-raised p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-4">
              <div>
                <div className="font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
                  stock of the week · week {cycle.week_no}
                </div>
                <div className="mt-1 font-mono text-3xl text-accent">
                  {cycle.stock_of_the_week.symbol}
                </div>
              </div>
              <div className="text-right font-mono text-xs text-ink-dim">
                <div>started {dateOnly(cycle.starts_at)}</div>
                {cycle.stock_of_the_week.token_address ? (
                  <div className="tnum mt-1">{cycle.stock_of_the_week.token_address}</div>
                ) : null}
              </div>
            </div>
            <div className="mt-5">
              <StreamBar startsAt={cycle.starts_at} endsAt={cycle.next_distribution_at} />
            </div>
            <p className="mt-4 text-sm text-ink-dim">
              Only the active week is ever shown. Next week&apos;s stock is revealed when this
              cycle ends.
            </p>
          </div>
        ) : (
          <p className="text-lg text-ink-dim">no active cycle yet</p>
        )}
        <div className="mt-6">
          <StakingPanel />
        </div>
      </section>

      {/* §02 — The mechanism */}
      <section>
        <SectionHead num="02" title="The mechanism" />
        <ol className="flex flex-col gap-0 border border-line">
          {[
            ["trades", "every $NOMA buy/sell on Pons pays a 1% creator tax in the quote asset"],
            ["escrow", "fees accrue in the Pons Fee Escrow, claimable by the Reward Engine Safe"],
            ["claim", "the Safe claims the escrow at cycle end — proposed by the backend, signed by the owners"],
            ["50 / 50", "half swapped to ZEC, half to the Stock of the Week"],
            ["notifyReward", "both assets are approved and streamed into NomaStaking"],
            ["stream", "rewards stream to stakers over 7 days, pro-rata to stake over time"],
            ["claimAll", "stakers claim whenever they want, one tx — rewards never expire"],
          ].map(([t, d], i) => (
            <li key={t} className="flex gap-4 border-b border-line px-4 py-3 last:border-b-0">
              <span className="tnum font-mono text-xs text-ink-dim">{String(i + 1).padStart(2, "0")}</span>
              <div>
                <span className="font-mono text-sm text-ink">{t}</span>
                <p className="mt-0.5 text-sm text-ink-dim">{d}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* §03 — History */}
      <section>
        <SectionHead num="03" title="History" />
        {!history ? (
          <p className="font-mono text-sm text-ink-dim">loading…</p>
        ) : history.cycles.length === 0 ? (
          <p className="text-lg text-ink-dim">no completed cycles yet</p>
        ) : (
          <div className="overflow-x-auto border border-line">
            <table className="w-full font-mono text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[0.7rem] tracking-widest text-ink-dim uppercase">
                  <th className="px-4 py-2 font-normal">week</th>
                  <th className="px-4 py-2 font-normal">stock</th>
                  <th className="px-4 py-2 font-normal">streamed</th>
                  <th className="px-4 py-2 font-normal">recipients</th>
                  <th className="px-4 py-2 font-normal">tx</th>
                </tr>
              </thead>
              <tbody>
                {history.cycles.map((c) => (
                  <tr key={c.week_no} className="border-b border-line last:border-b-0">
                    <td className="tnum px-4 py-2.5">{c.week_no}</td>
                    <td className="px-4 py-2.5 text-accent">{c.stock_symbol}</td>
                    <td className="tnum px-4 py-2.5">
                      {c.streamed_to_stakers
                        .map((s) => `${amount(s.amount)} ${s.asset}`)
                        .join(" · ") || "—"}
                    </td>
                    <td className="tnum px-4 py-2.5">{c.recipients}</td>
                    <td className="px-4 py-2.5">
                      {c.streamed_to_stakers[0] ? (
                        <TxLink hash={c.streamed_to_stakers[0].tx_hash} />
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {txs && txs.transactions.length > 0 ? (
          <div className="mt-6">
            <div className="mb-2 font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
              engine transactions
            </div>
            <div className="divide-y divide-line border border-line">
              {txs.transactions.slice(0, 10).map((t, i) => (
                <div key={i} className="flex flex-wrap items-baseline gap-x-4 px-4 py-2.5 font-mono text-sm">
                  <span className="text-ink-dim">{t.kind.replaceAll("_", " ")}</span>
                  <span className="tnum">
                    {amount(t.amount)} {t.asset}
                  </span>
                  {t.usd_value ? <span className="tnum text-ink-dim">{usd(t.usd_value)}</span> : null}
                  <span className="ml-auto">
                    <TxLink hash={t.tx_hash} />
                  </span>
                  <span className="tnum w-full text-xs text-ink-dim sm:w-auto">
                    {dateTime(t.ts)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      {/* §04 — Methodology */}
      <section>
        <SectionHead num="04" title="Methodology" />
        {methodology ? (
          <div className="border border-line bg-bg-raised p-5">
            <div className="flex flex-wrap gap-x-8 gap-y-2 font-mono text-xs text-ink-dim">
              <span>version {methodology.version}</span>
              <span>unstake cooldown {secondsToDays(methodology.unstake_cooldown_seconds)}</span>
              <span>reward stream {secondsToDays(methodology.reward_stream_seconds)}</span>
            </div>
            <ul className="mt-4 flex flex-col gap-2">
              {methodology.rules.map((r, i) => (
                <li key={i} className="flex gap-3 text-sm text-ink-dim">
                  <span className="tnum font-mono text-xs">{i + 1}.</span>
                  {r}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="font-mono text-sm text-ink-dim">loading…</p>
        )}
      </section>
    </div>
  );
}
