"use client";

import { useEffect, useState } from "react";
import { ghostMissionReceipt } from "@/lib/api";
import { dateTime, usd } from "@/lib/format";
import type { GhostReceipt as GhostReceiptType } from "@/lib/types";

const FIELD_LABELS: Record<string, string> = {
  email: "email address",
  name: "name",
  phone: "phone number",
  address: "address",
  wallet: "wallet address",
  payment: "payment details",
  other: "personal data",
};

export function GhostReceipt({ vaultKey, missionId }: { vaultKey: string; missionId: string }) {
  const [receipt, setReceipt] = useState<GhostReceiptType | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    ghostMissionReceipt(vaultKey, missionId)
      .then((r) => {
        if (!cancelled) setReceipt(r);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "receipt unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [vaultKey, missionId]);

  if (error) return <p className="font-mono text-sm text-warn">{error}</p>;
  if (!receipt) return <p className="font-mono text-sm text-ink-dim">loading receipt…</p>;

  const sharedReal = receipt.info_shared.real.length > 0;

  return (
    <div className="flex flex-col gap-4 border border-line bg-bg-raised p-4">
      <div className="flex items-baseline justify-between gap-4">
        <p className="rule-label">ghost receipt</p>
        <p className="tnum font-mono text-xs text-ink-dim">{dateTime(receipt.created_at)}</p>
      </div>

      <section>
        <h3 className="field-label">sites visited</h3>
        {receipt.sites_visited.length === 0 ? (
          <p className="font-mono text-xs text-ink-dim">no pages were opened</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1">
            {receipt.sites_visited.map((url) => (
              <li key={url} className="truncate font-mono text-xs text-ink-dim" title={url}>
                {url}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="field-label">actions performed</h3>
        {Object.keys(receipt.actions).length === 0 ? (
          <p className="font-mono text-xs text-ink-dim">none</p>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-ink">
            {Object.entries(receipt.actions).map(([kind, count]) => (
              <li key={kind}>
                <span className="text-ink-dim">{kind}:</span> <span className="tnum">{count}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="field-label">permissions used</h3>
        {receipt.permissions.length === 0 ? (
          <p className="font-mono text-xs text-ink-dim">no permission requests</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1 font-mono text-xs text-ink">
            {receipt.permissions.map((p, i) => (
              <li key={i}>
                {FIELD_LABELS[p.field] ?? p.field} ·{" "}
                <span className={p.decision === "approve" ? "text-warn" : "text-accent"}>{p.decision}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="field-label">information shared</h3>
        {!sharedReal && receipt.info_shared.aliased.length === 0 ? (
          <p className="font-mono text-xs text-accent">no personal data was shared</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1 font-mono text-xs">
            {sharedReal ? (
              <li className="text-warn">
                real: {receipt.info_shared.real.map((f) => FIELD_LABELS[f] ?? f).join(", ")} — value never
                stored
              </li>
            ) : null}
            {receipt.info_shared.aliased.map((a, i) => (
              <li key={i} className="text-ink">
                aliased: {FIELD_LABELS[a.field] ?? a.field} → <span className="text-ink-dim">{a.value}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {receipt.purchases.length > 0 ? (
        <section>
          <h3 className="field-label">agent purchases</h3>
          <ul className="mt-1 flex flex-col gap-1 font-mono text-xs text-ink">
            {receipt.purchases.map((p, i) => (
              <li key={i}>
                {p.title} · <span className="tnum text-accent">{usd(p.price_usd)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {receipt.recommendations.length > 0 ? (
        <section>
          <h3 className="field-label">recommendations</h3>
          <div className="mt-1 grid gap-px border border-line bg-line sm:grid-cols-2">
            {receipt.recommendations.map((r) => (
              <div key={r.name} className="bg-bg p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="text-sm text-ink">{r.name}</div>
                  <span className="tnum font-mono text-sm">{usd(r.price_usd)}</span>
                </div>
                <p className="mt-1 text-xs text-ink-dim">{r.privacy_note}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
