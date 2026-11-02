"use client";

import useSWR from "swr";
import { dateOnly, dateTime, usd } from "@/lib/format";
import type { AiUsageRow, AiUsageSnapshot, ApiKeyPayload } from "@/lib/types";

async function fetchUsage(url: string, key: string): Promise<AiUsageSnapshot> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) {
    let message = `usage request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // keep default
    }
    throw new Error(message);
  }
  return res.json() as Promise<AiUsageSnapshot>;
}

async function fetchHistory(url: string, key: string): Promise<{ usage: AiUsageRow[] }> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`history request failed (${res.status})`);
  return res.json() as Promise<{ usage: AiUsageRow[] }>;
}

/** Live balance and recent requests from the AI gateway. Uses the delivered key; never stores it. */
export function AiUsage({ payload, revoked = false }: { payload: ApiKeyPayload; revoked?: boolean }) {
  const url = payload.usage_url ?? `${payload.base_url.replace(/\/$/, "")}/usage`;
  const historyUrl = `${url.replace(/\/$/, "")}/history?limit=5`;
  const cacheId = payload.key_last4 ?? payload.api_key.slice(-6);
  const { data, error, isLoading } = useSWR(
    revoked ? null : ["ai-usage", url, cacheId],
    () => fetchUsage(url, payload.api_key),
    { refreshInterval: 60_000, revalidateOnFocus: true },
  );
  const { data: history } = useSWR(
    revoked ? null : ["ai-usage-history", historyUrl, cacheId],
    () => fetchHistory(historyUrl, payload.api_key),
    { refreshInterval: 60_000, revalidateOnFocus: true },
  );

  if (revoked) {
    return (
      <div className="mt-4 border border-bad bg-bg p-3">
        <div className="font-mono text-[0.7rem] tracking-widest text-bad uppercase">key revoked</div>
        <p className="mt-2 text-xs leading-5 text-ink-dim">
          this key is no longer accepted. rotate it above to get a fresh key with the same remaining
          balance.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 border border-line bg-bg p-3">
      <div className="flex items-baseline justify-between gap-4 font-mono text-[0.7rem] tracking-widest uppercase">
        <span className="text-ink-dim">live usage</span>
        <span className={error ? "text-warn" : "text-ink-dim"}>
          {isLoading ? "checking…" : error ? "unavailable" : "refreshes every 60s"}
        </span>
      </div>

      {data ? (
        <>
          <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm text-ink-dim">remaining</span>
            <span className="display tnum text-3xl tracking-[-0.04em]">
              {usd(data.remaining_usd, { decimals: 4 })}
            </span>
          </div>
          <div className="mt-3 flex flex-col gap-1 border-t border-line pt-2 font-mono text-xs">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-ink-dim">credit</span>
              <span className="tnum">{usd(data.credit_usd, { decimals: 4 })}</span>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-ink-dim">used</span>
              <span className="tnum">{usd(data.used_usd, { decimals: 4 })}</span>
            </div>
            {data.reserved_usd > 0 ? (
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-ink-dim">reserved</span>
                <span className="tnum">{usd(data.reserved_usd, { decimals: 4 })}</span>
              </div>
            ) : null}
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-ink-dim">expires</span>
              <span>{dateOnly(data.expires_at)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-ink-dim">key</span>
              <span className="text-ink">••••{data.key_last4}</span>
            </div>
          </div>
        </>
      ) : error ? (
        <p className="mt-2 text-xs leading-5 text-ink-dim">
          balance unavailable: {error.message}. The key may be revoked or expired, or the gateway is
          unreachable from this browser.
        </p>
      ) : (
        <p className="mt-2 text-xs text-ink-dim">reading the key balance…</p>
      )}

      {history && history.usage.length > 0 ? (
        <div className="mt-3 border-t border-line pt-2">
          <div className="font-mono text-[0.65rem] tracking-widest text-ink-dim uppercase">
            recent requests
          </div>
          <div className="mt-1 flex flex-col gap-1 font-mono text-[0.68rem]">
            {history.usage.map((row) => (
              <div key={row.id} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-ink-dim">
                  {dateTime(row.created_at)} · {row.model.split("/").pop()}
                </span>
                <span className="tnum shrink-0 text-ink-dim">
                  {row.retail_cost_usd === null ? row.status : usd(row.retail_cost_usd, { decimals: 5 })}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
