"use client";

import { useEffect, useState } from "react";
import {
  ApiError,
  getAdminClaims,
  getAdminRefunds,
  resolveAdminClaim,
  retryAdminRefund,
  sendAdminTestAlert,
} from "@/lib/api";
import { dateTime, fromRaw, shortAddress } from "@/lib/format";
import type { AdminRefund, PaymentClaim } from "@/lib/types";

const TOKEN_KEY = "noma:admin-token";

function amount(value: string, asset: string): string {
  if (asset === "USDG" || asset === "ETH") return `${fromRaw(value, asset === "USDG" ? 6 : 18)} ${asset}`;
  return `${value} ${asset.replace(/^TOKEN:/, "token ")}`;
}

export default function AdminOpsPage() {
  const [token, setToken] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [claims, setClaims] = useState<PaymentClaim[]>([]);
  const [refunds, setRefunds] = useState<AdminRefund[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const saved = sessionStorage.getItem(TOKEN_KEY);
    // reading sessionStorage after mount is intentional (SSR renders the same shell)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved) setToken(saved);
  }, []);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    Promise.all([getAdminClaims(token, "open"), getAdminRefunds(token, "failed")])
      .then(([claimsRes, refundsRes]) => {
        if (!alive) return;
        setClaims(claimsRes.claims);
        setRefunds(refundsRes.refunds);
      })
      .catch((err) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 401) {
          sessionStorage.removeItem(TOKEN_KEY);
          setToken(null);
          setError("token rejected — enter the admin token again");
        } else {
          setError(err instanceof Error ? err.message : "could not load ops data");
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [token, reload]);

  function signIn(e: React.FormEvent) {
    e.preventDefault();
    const next = input.trim();
    if (!next) return;
    sessionStorage.setItem(TOKEN_KEY, next);
    setToken(next);
    setInput("");
  }

  function signOut() {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setClaims([]);
    setRefunds([]);
    setError(null);
    setNotice(null);
  }

  function refresh() {
    setReload((n) => n + 1);
  }

  async function resolve(claim: PaymentClaim, action: "accept" | "reject") {
    if (!token) return;
    if (action === "accept" && !window.confirm("Accept this payment? This can start fulfillment.")) return;
    const note =
      action === "reject"
        ? (window.prompt("Reason for rejecting (optional)") ?? undefined)
        : undefined;
    setBusy(claim.id);
    setError(null);
    try {
      const res = await resolveAdminClaim(token, claim.id, action, note);
      setNotice(
        action === "accept"
          ? `claim accepted${res.queued ? " — fulfillment queued" : ""}`
          : "claim rejected",
      );
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not resolve claim");
    } finally {
      setBusy(null);
    }
  }

  async function retry(refund: AdminRefund) {
    if (!token) return;
    if (!window.confirm(`Retry ${refund.kind} refund for ${refund.order_id}?`)) return;
    setBusy(refund.id);
    setError(null);
    try {
      await retryAdminRefund(token, refund.order_id, refund.kind);
      setNotice("refund retry queued");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not retry refund");
    } finally {
      setBusy(null);
    }
  }

  async function testAlert() {
    if (!token) return;
    setBusy("alert");
    setError(null);
    try {
      const res = await sendAdminTestAlert(token);
      setNotice(
        res.delivery_configured
          ? "test alert sent to the configured channel"
          : "test alert written to the log only — no Telegram/webhook configured",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not send test alert");
    } finally {
      setBusy(null);
    }
  }

  if (!token) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-6 py-10">
        <div>
          <div className="rule-label">internal</div>
          <h1 className="mt-3 text-3xl tracking-tight">Ops console</h1>
          <p className="mt-2 text-sm text-ink-dim">
            Admin token only. Stored in this tab&apos;s sessionStorage; it is never included in the
            public bundle or the URL.
          </p>
        </div>
        <form onSubmit={signIn} className="border border-line bg-bg-raised p-4">
          <label htmlFor="admin-token" className="field-label">
            admin token
          </label>
          <input
            id="admin-token"
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            autoComplete="off"
            className="field"
          />
          <button type="submit" className="btn mt-3 w-full">
            open ops
          </button>
        </form>
        {error ? <p className="font-mono text-sm text-bad">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="rule-label">internal · noindex</div>
          <h1 className="mt-3 text-3xl tracking-tight sm:text-4xl">Ops console</h1>
          <p className="mt-2 max-w-2xl text-sm text-ink-dim">
            Buyer-reported payments and failed refunds. Actions are admin-only and use the server&apos;s
            ADMIN_TOKEN.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={testAlert}
            disabled={busy === "alert"}
            className="border border-line px-3 py-2 font-mono text-[0.68rem] tracking-widest uppercase hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {busy === "alert" ? "sending…" : "test alert"}
          </button>
          <button
            type="button"
            onClick={refresh}
            className="border border-line px-3 py-2 font-mono text-[0.68rem] tracking-widest uppercase hover:border-accent hover:text-accent"
          >
            refresh
          </button>
          <button
            type="button"
            onClick={signOut}
            className="border border-line px-3 py-2 font-mono text-[0.68rem] tracking-widest text-ink-dim uppercase hover:text-ink"
          >
            sign out
          </button>
        </div>
      </div>

      {notice ? <p className="border border-line bg-bg-raised px-4 py-3 font-mono text-sm text-good">{notice}</p> : null}
      {error ? <p className="border border-bad bg-bg-raised px-4 py-3 font-mono text-sm text-bad">{error}</p> : null}

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <div className="rule-label">payment claims</div>
            <p className="mt-1 text-xs text-ink-dim">Buyer-reported transfers the exact-amount watcher could not match.</p>
          </div>
          <span className="font-mono text-xs text-ink-dim">{loading ? "loading…" : `${claims.length} open`}</span>
        </div>
        {!loading && claims.length === 0 ? (
          <p className="border border-line bg-bg-raised px-4 py-3 font-mono text-sm text-ink-dim">no open claims</p>
        ) : claims.length > 0 ? (
          <div className="overflow-x-auto border border-line">
            <table className="w-full font-mono text-xs">
              <thead>
                <tr className="border-b border-line text-left text-[0.65rem] tracking-widest text-ink-dim uppercase">
                  <th className="px-3 py-2 font-normal">order</th>
                  <th className="px-3 py-2 font-normal">tx / asset</th>
                  <th className="px-3 py-2 font-normal">payer</th>
                  <th className="px-3 py-2 font-normal">reported</th>
                  <th className="px-3 py-2 font-normal">action</th>
                </tr>
              </thead>
              <tbody>
                {claims.map((claim) => (
                  <tr key={claim.id} className="border-b border-line align-top last:border-b-0">
                    <td className="max-w-[16rem] break-all px-3 py-2.5 text-ink">{claim.order_id}</td>
                    <td className="px-3 py-2.5">
                      <div className="break-all text-ink-dim">{claim.tx_hash}</div>
                      <div className="mt-1 text-ink">{amount(claim.amount, claim.asset)}</div>
                    </td>
                    <td className="px-3 py-2.5 text-ink-dim">{claim.payer_address ? shortAddress(claim.payer_address) : "—"}</td>
                    <td className="px-3 py-2.5 text-ink-dim">{dateTime(claim.created_at)}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => resolve(claim, "accept")}
                          disabled={busy === claim.id}
                          className="border border-line px-2 py-1 text-[0.65rem] tracking-widest uppercase hover:border-accent hover:text-accent disabled:opacity-50"
                        >
                          accept
                        </button>
                        <button
                          type="button"
                          onClick={() => resolve(claim, "reject")}
                          disabled={busy === claim.id}
                          className="border border-line px-2 py-1 text-[0.65rem] tracking-widest text-bad uppercase hover:border-bad disabled:opacity-50"
                        >
                          reject
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <div className="rule-label">failed refunds</div>
            <p className="mt-1 text-xs text-ink-dim">Retry after funding gas/float; a confirmed refund is rejected by the API.</p>
          </div>
          <span className="font-mono text-xs text-ink-dim">{loading ? "loading…" : `${refunds.length} failed`}</span>
        </div>
        {!loading && refunds.length === 0 ? (
          <p className="border border-line bg-bg-raised px-4 py-3 font-mono text-sm text-ink-dim">no failed refunds</p>
        ) : refunds.length > 0 ? (
          <div className="overflow-x-auto border border-line">
            <table className="w-full font-mono text-xs">
              <thead>
                <tr className="border-b border-line text-left text-[0.65rem] tracking-widest text-ink-dim uppercase">
                  <th className="px-3 py-2 font-normal">order / kind</th>
                  <th className="px-3 py-2 font-normal">amount</th>
                  <th className="px-3 py-2 font-normal">created</th>
                  <th className="px-3 py-2 font-normal">action</th>
                </tr>
              </thead>
              <tbody>
                {refunds.map((refund) => (
                  <tr key={refund.id} className="border-b border-line last:border-b-0">
                    <td className="max-w-[22rem] break-all px-3 py-2.5">
                      <div className="text-ink">{refund.order_id}</div>
                      <div className="mt-1 text-ink-dim">{refund.kind}</div>
                    </td>
                    <td className="px-3 py-2.5 text-ink">{amount(refund.amount, refund.asset)}</td>
                    <td className="px-3 py-2.5 text-ink-dim">{dateTime(refund.created_at)}</td>
                    <td className="px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() => retry(refund)}
                        disabled={busy === refund.id}
                        className="border border-line px-2 py-1 text-[0.65rem] tracking-widest uppercase hover:border-accent hover:text-accent disabled:opacity-50"
                      >
                        {busy === refund.id ? "queueing…" : "retry"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <p className="font-mono text-xs text-ink-dim">
        noindex · token stored only in this tab · actions are written to the API/worker logs.
      </p>
    </div>
  );
}
