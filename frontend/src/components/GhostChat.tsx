"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ghostChat, ghostMissionGet, ghostMissionsList } from "@/lib/api";
import { dateTime, fromRaw, usd } from "@/lib/format";
import { orderUrl } from "@/lib/orderKey";
import type {
  GhostMissionSummary,
  GhostPermissionRequest,
  GhostPurchase,
  GhostPurchaseRequest,
  GhostRecommendation,
} from "@/lib/types";
import { GhostReceipt } from "./GhostReceipt";

interface ChatMessage {
  role: "you" | "ghost";
  text: string;
  recommendations?: GhostRecommendation[];
  purchases?: GhostPurchase[];
}

const FIELD_LABELS: Record<string, string> = {
  email: "email address",
  name: "name",
  phone: "phone number",
  address: "address",
  wallet: "wallet address",
  payment: "payment details",
  other: "personal data",
};

export function GhostChat({ vaultKey }: { vaultKey: string }) {
  const [missions, setMissions] = useState<GhostMissionSummary[]>([]);
  const [missionId, setMissionId] = useState<string | undefined>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState<GhostPermissionRequest | null>(null);
  const [purchaseAsk, setPurchaseAsk] = useState<GhostPurchaseRequest | null>(null);
  const [decision, setDecision] = useState<"approve" | "alias" | "deny">("approve");
  const [value, setValue] = useState("");
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const refreshMissions = useCallback(async () => {
    try {
      const res = await ghostMissionsList(vaultKey);
      setMissions(res.missions);
    } catch {
      // list failure is non-fatal
    }
  }, [vaultKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshMissions();
  }, [refreshMissions]);

  async function openMission(id: string) {
    setMissionId(id);
    setReceiptId(null);
    setPermission(null);
    setPurchaseAsk(null);
    setMessages([]);
    try {
      const m = await ghostMissionGet(vaultKey, id);
      setMessages(m.messages.map((msg) => ({ role: msg.role === "user" ? "you" : "ghost", text: msg.content })));
    } catch {
      setMessages([]);
    }
  }

  function newMission() {
    setMissionId(undefined);
    setMessages([]);
    setPermission(null);
    setPurchaseAsk(null);
    setReceiptId(null);
    setError(null);
  }

  async function send(
    message: string,
    permissionPayload?: { decision: "approve" | "alias" | "deny"; value?: string },
    purchasePayload?: { decision: "approve" | "cancel" },
  ) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await ghostChat(vaultKey, {
        mission_id: missionId,
        message,
        permission: permissionPayload,
        purchase: purchasePayload,
      });
      setMissionId(res.mission_id);
      setMessages((m) => [
        ...m,
        {
          role: "ghost",
          text: res.message,
          recommendations: res.recommendations.length ? res.recommendations : undefined,
          purchases: res.purchases.length ? res.purchases : undefined,
        },
      ]);
      setPurchaseAsk(res.purchase_request);
      if (res.permission_request) {
        setPermission(res.permission_request);
        setDecision("approve");
        setValue("");
      } else {
        setPermission(null);
      }
      void refreshMissions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "ghost agent error");
    } finally {
      setBusy(false);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  }

  function submitPurchase(decision: "approve" | "cancel") {
    if (!purchaseAsk || busy) return;
    const label =
      decision === "approve"
        ? `Confirm the purchase of ${purchaseAsk.title}.`
        : `Cancel the purchase of ${purchaseAsk.title}.`;
    setMessages((m) => [...m, { role: "you", text: label }]);
    setPurchaseAsk(null);
    void send(label, undefined, { decision });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy || permission) return;
    setInput("");
    setMessages((m) => [...m, { role: "you", text }]);
    void send(text);
  }

  function submitDecision(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !permission) return;
    if (decision === "approve" && !value.trim()) return;
    const label =
      decision === "approve"
        ? `Approved: share my real ${FIELD_LABELS[permission.field] ?? permission.field}.`
        : decision === "alias"
          ? `Use the alias instead of the real ${FIELD_LABELS[permission.field] ?? permission.field}.`
          : "Denied: do not share it, work around it.";
    setMessages((m) => [...m, { role: "you", text: label }]);
    void send(label, { decision, value: value.trim() || undefined });
  }

  return (
    <div className="grid gap-6 md:grid-cols-[220px_1fr]">
      <aside className="flex flex-col gap-2 md:border-r md:border-line md:pr-4">
        <button type="button" onClick={newMission} className="btn w-full">
          new mission
        </button>
        {missions.length === 0 ? (
          <p className="font-mono text-xs text-ink-dim">no missions yet</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {missions.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => void openMission(m.id)}
                  className={`w-full border px-2 py-1.5 text-left font-mono text-xs transition-colors hover:border-accent ${
                    missionId === m.id ? "border-accent text-ink" : "border-line text-ink-dim"
                  }`}
                >
                  <span className="block truncate">{m.title || "(untitled)"}</span>
                  <span className="block text-[0.62rem] text-ink-dim">
                    {dateTime(m.created_at)} · {m.status}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="flex min-w-0 flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-lg font-medium tracking-tight">
            {missionId ? "mission" : "new mission"}
          </h2>
          {missionId ? (
            <button
              type="button"
              onClick={() => setReceiptId(receiptId ? null : missionId)}
              className="font-mono text-xs tracking-widest text-accent uppercase hover:underline"
            >
              {receiptId ? "hide receipt" : "ghost receipt"}
            </button>
          ) : null}
        </div>

        {receiptId ? (
          <GhostReceipt vaultKey={vaultKey} missionId={receiptId} />
        ) : null}

        <div className="flex min-h-64 flex-col gap-4 border border-line bg-bg-raised p-4">
          {messages.length === 0 ? (
            <div className="flex flex-col gap-3">
              <p className="font-mono text-sm text-ink-dim">
                describe a task; the agent researches the public web under your privacy rules, or start from:
              </p>
              <div className="flex flex-wrap gap-2">
                {[
                  "find me a privacy-friendly VPS under $10/month that does not require a phone number",
                  "compare VPNs that accept crypto and ask for the least personal data",
                ].map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => setInput(example)}
                    className="inline-flex min-h-11 items-center border border-line px-3 text-left font-mono text-xs text-ink-dim transition-colors hover:border-accent hover:text-accent"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
              <div key={i} className="flex flex-col gap-2">
                <div className="font-mono text-sm">
                  <span className="text-ink-dim">{m.role} · </span>
                  <span className="whitespace-pre-wrap text-ink">{m.text}</span>
                </div>
                {m.recommendations ? (
                  <div className="grid gap-px border border-line bg-line sm:grid-cols-2">
                    {m.recommendations.map((r) => (
                      <div key={r.name} className="bg-bg p-3">
                        <div className="flex items-baseline justify-between gap-2">
                          <div className="text-sm text-ink">{r.name}</div>
                          <span className="tnum font-mono text-sm">{usd(r.price_usd)}</span>
                        </div>
                        <p className="mt-1 text-xs text-ink-dim">{r.privacy_note}</p>
                        <p className="mt-1 text-xs text-ink-dim">{r.reason}</p>
                        {r.url ? (
                          <a
                            href={r.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="mt-2 inline-block truncate font-mono text-xs text-accent hover:underline"
                          >
                            {r.url}
                          </a>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
                {m.purchases ? (
                  <div className="grid gap-px border border-accent/40 bg-line sm:grid-cols-2">
                    {m.purchases.map((p) => (
                      <div key={p.order_id} className="bg-bg p-3">
                        <div className="flex items-baseline justify-between gap-2">
                          <div className="text-sm text-ink">{p.title}</div>
                          <span className="tnum font-mono text-sm text-accent">{usd(p.price_usd)}</span>
                        </div>
                        <p className="mt-1 font-mono text-xs text-ink-dim">
                          order created · pay {fromRaw(p.amount, p.asset === "USDG" ? 6 : 18)} {p.asset} from
                          your wallet
                        </p>
                        <Link
                          href={orderUrl(p.order_id, p.order_key)}
                          className="mt-2 inline-block font-mono text-xs text-accent hover:underline"
                        >
                          open order &amp; pay →
                        </Link>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))
          )}
          {busy ? <p className="font-mono text-sm text-ink-dim">researching the web…</p> : null}
          {error ? <p className="font-mono text-sm text-warn">{error}</p> : null}
          <div ref={bottomRef} />
        </div>

        {purchaseAsk ? (
          <div className="flex flex-col gap-2 border border-accent/50 bg-bg-raised p-4">
            <p className="rule-label">purchase confirmation</p>
            <p className="font-mono text-sm text-ink">
              the agent wants to buy <span className="text-accent">{purchaseAsk.title}</span> for{" "}
              <span className="tnum text-accent">{usd(purchaseAsk.price_usd)}</span>
            </p>
            <p className="font-mono text-xs text-ink-dim">{purchaseAsk.reason}</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => submitPurchase("approve")}
                disabled={busy}
                className="inline-flex min-h-11 items-center border border-accent px-3 font-mono text-xs text-accent uppercase transition-colors hover:bg-accent hover:text-bg"
              >
                confirm purchase
              </button>
              <button
                type="button"
                onClick={() => submitPurchase("cancel")}
                disabled={busy}
                className="inline-flex min-h-11 items-center border border-line px-3 font-mono text-xs text-ink-dim uppercase transition-colors hover:border-accent"
              >
                cancel
              </button>
            </div>
            <p className="font-mono text-[0.62rem] text-ink-dim">
              nothing is ordered until you confirm. the order is an invoice — you pay it from your
              own wallet.
            </p>
          </div>
        ) : permission ? (
          <form onSubmit={submitDecision} className="flex flex-col gap-2 border border-line bg-bg-raised p-4">
            <p className="rule-label">privacy check</p>
            <p className="font-mono text-sm text-ink">
              the agent wants your <span className="text-accent">{FIELD_LABELS[permission.field] ?? permission.field}</span>:
              <span className="text-ink-dim"> {permission.reason}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {(["approve", ...(permission.has_alias ? ["alias" as const] : []), "deny"] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDecision(d)}
                  className={`inline-flex min-h-11 items-center border px-3 font-mono text-xs uppercase transition-colors ${
                    decision === d ? "border-accent text-accent" : "border-line text-ink-dim hover:border-accent"
                  }`}
                >
                  {d === "approve" ? "approve real value" : d === "alias" ? "use alias" : "deny"}
                </button>
              ))}
            </div>
            {decision === "approve" ? (
              <>
                <input
                  type="text"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={`your real ${FIELD_LABELS[permission.field] ?? permission.field}…`}
                  className="field"
                />
                <p className="font-mono text-[0.62rem] text-ink-dim">
                  the value is logged as shared in the receipt and never stored
                </p>
              </>
            ) : null}
            <div className="flex gap-2">
              <button type="submit" disabled={busy || (decision === "approve" && !value.trim())} className="btn">
                send decision
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-2">
            <label htmlFor="ghost-input" className="field-label">
              your request
            </label>
            <div className="flex gap-2">
              <input
                id="ghost-input"
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="describe the task…"
                maxLength={2000}
                disabled={busy}
                className="field min-w-0 flex-1"
              />
              <button type="submit" disabled={busy || !input.trim()} className="btn">
                send
              </button>
            </div>
          </form>
        )}

        <p className="font-mono text-xs text-ink-dim">
          every search and page fetch is server-side and logged; real personal data is only shared
          with your explicit approval. the ghost receipt shows exactly what happened.
        </p>
      </section>
    </div>
  );
}
