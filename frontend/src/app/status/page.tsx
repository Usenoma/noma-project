"use client";

import useSWR from "swr";

interface Ready {
  status: number;
  ok?: boolean;
  checks?: Record<string, string>;
  error?: string;
}

const fetcher = async (url: string): Promise<Ready> => {
  const res = await fetch(url);
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; checks?: Record<string, string>; error?: string };
  return { status: res.status, ...body };
};

export default function StatusPage() {
  const { data, error } = useSWR<Ready>("/api/ready", fetcher, { refreshInterval: 15_000 });

  return (
    <div className="flex max-w-2xl flex-col gap-8">
      <div>
        <div className="rule-label">status</div>
        <h1 className="mt-3 text-3xl font-medium tracking-tight">System status</h1>
        <p className="mt-2 text-sm text-ink-dim">
          Live health of the NOMA API, database, Redis and workers. Refreshes every 15 seconds.
        </p>
      </div>

      <div className="border border-line bg-bg-raised">
        <div className="flex items-baseline justify-between border-b border-line px-4 py-2">
          <span className="font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
            fig. — the health check
          </span>
          {data ? (
            <span className={`font-mono text-sm ${data.ok ? "text-good" : "text-bad"}`}>
              {data.ok ? "ok" : "degraded"}
            </span>
          ) : null}
        </div>
        <div className="p-4">
          {error ? (
            <p className="font-mono text-sm text-bad">unreachable — the API did not respond</p>
          ) : !data ? (
            <p className="font-mono text-sm text-ink-dim">checking…</p>
          ) : (
            <div className="flex flex-col gap-2">
              {data.checks && Object.keys(data.checks).length > 0 ? (
                Object.entries(data.checks).map(([name, value]) => (
                  <div key={name} className="flex items-baseline justify-between">
                    <span className="font-mono text-sm text-ink-dim">{name}</span>
                    <span className={`font-mono text-sm ${value === "ok" ? "text-good" : "text-bad"}`}>
                      {value}
                    </span>
                  </div>
                ))
              ) : (
                <p className="font-mono text-sm text-ink-dim">no checks reported</p>
              )}
            </div>
          )}
        </div>
      </div>

      <p className="font-mono text-xs text-ink-dim">
        this page reads the backend <span className="text-ink">/ready</span> endpoint through the
        same-origin proxy — no account required.
      </p>
    </div>
  );
}
