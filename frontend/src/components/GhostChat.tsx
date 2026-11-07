"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ghostChat, ghostMissionDelete, ghostMissionGet, ghostMissionsList } from "@/lib/api";
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

const EXAMPLES = [
  "Find a privacy-friendly VPS under $10/month that does not require a phone number",
  "Compare 2 VPNs that accept crypto and ask for the least personal data",
  "Buy me the $5 NOMA AI credits from the NOMA catalog",
];

function Avatar() {
  return (
    <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full border border-line-strong bg-black">
      <Image src="/brand/logo.jpg" alt="" width={28} height={28} className="scale-[1.5] object-contain" />
    </span>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1" aria-label="researching">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-dim [animation-delay:0ms]" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-dim [animation-delay:150ms]" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-dim [animation-delay:300ms]" />
    </span>
  );
}

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
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, busy, purchaseAsk, permission]);

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

  async function removeMission(id: string) {
    if (busy) return;
    setDeletingId(null);
    try {
      await ghostMissionDelete(vaultKey, id);
      if (missionId === id) newMission();
      await refreshMissions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not delete the mission");
    }
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
    if (!text || busy || permission || purchaseAsk) return;
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

  const activeTitle = missions.find((m) => m.id === missionId)?.title || (missionId ? "mission" : "new mission");

  return (
    <div className="grid h-[78svh] min-h-[540px] overflow-hidden border border-line bg-bg md:grid-cols-[250px_1fr]">
      {/* mission history — ChatGPT-style rail */}
      <aside className="hidden flex-col border-r border-line bg-bg-raised/40 md:flex">
        <div className="border-b border-line p-3">
          <button type="button" onClick={newMission} className="btn w-full">
            + new mission
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          <p className="px-2 py-1 font-mono text-[0.6rem] tracking-[0.16em] text-ink-dim uppercase">missions</p>
          {missions.length === 0 ? (
            <p className="px-2 py-2 font-mono text-xs text-ink-dim">nothing yet</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {missions.map((m) => (
                <li key={m.id}>
                  <div
                    className={`group flex items-stretch rounded-md transition-colors ${
                      missionId === m.id ? "bg-bg" : "hover:bg-bg"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => void openMission(m.id)}
                      title={m.title || undefined}
                      className={`min-w-0 flex-1 px-2 py-2 text-left font-mono text-xs transition-colors ${
                        missionId === m.id ? "text-ink" : "text-ink-dim group-hover:text-ink"
                      }`}
                    >
                      <span className="block truncate">{m.title || "(untitled)"}</span>
                      <span className="block text-[0.58rem] text-ink-dim">
                        {dateTime(m.created_at)} · {m.status}
                      </span>
                    </button>
                    {deletingId === m.id ? (
                      <span className="flex items-center gap-1 pr-1.5">
                        <button
                          type="button"
                          onClick={() => void removeMission(m.id)}
                          className="rounded px-1.5 py-1 font-mono text-[0.58rem] text-warn uppercase hover:bg-bg"
                        >
                          delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeletingId(null)}
                          className="rounded px-1.5 py-1 font-mono text-[0.58rem] text-ink-dim uppercase hover:bg-bg"
                        >
                          no
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        aria-label={`delete mission ${m.title ?? ""}`}
                        onClick={() => setDeletingId(m.id)}
                        className="px-2 font-mono text-xs text-ink-dim opacity-60 transition-opacity hover:text-warn hover:opacity-100 focus:opacity-100"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-t border-line p-3 font-mono text-[0.58rem] leading-4 text-ink-dim">
          research runs under your privacy rules; real data needs your approval.
        </div>
      </aside>

      {/* conversation */}
      <section className="flex min-h-0 min-w-0 flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <div className="flex min-w-0 items-baseline gap-3">
            <p className="truncate font-mono text-xs text-ink">{activeTitle}</p>
            <span className="hidden shrink-0 font-mono text-[0.58rem] tracking-widest text-ink-dim uppercase sm:inline">
              ghost agent
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button type="button" onClick={newMission} className="font-mono text-[0.62rem] tracking-widest text-ink-dim uppercase hover:text-accent md:hidden">
              + new
            </button>
            {missionId ? (
              <button
                type="button"
                onClick={() => setReceiptId(receiptId ? null : missionId)}
                className="font-mono text-[0.62rem] tracking-widest text-accent uppercase hover:underline"
              >
                {receiptId ? "hide receipt" : "ghost receipt"}
              </button>
            ) : null}
          </div>
        </div>

        {/* mobile mission switcher — the history rail is desktop-only */}
        {missions.length > 0 ? (
          <div className="flex items-center gap-1.5 overflow-x-auto border-b border-line px-2 py-1.5 md:hidden">
            {missions.map((m) =>
              deletingId === m.id ? (
                <span
                  key={m.id}
                  className="flex shrink-0 items-center gap-2 rounded-full border border-warn/60 px-2.5 py-1 font-mono text-[0.6rem]"
                >
                  <button type="button" onClick={() => void removeMission(m.id)} className="text-warn uppercase">
                    delete
                  </button>
                  <button type="button" onClick={() => setDeletingId(null)} className="text-ink-dim uppercase">
                    no
                  </button>
                </span>
              ) : (
                <span
                  key={m.id}
                  className={`flex shrink-0 items-center rounded-full border ${
                    missionId === m.id ? "border-accent text-accent" : "border-line text-ink-dim"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => void openMission(m.id)}
                    className="max-w-40 truncate py-1 pl-2.5 pr-1 font-mono text-[0.6rem]"
                  >
                    {m.title || "(untitled)"}
                  </button>
                  <button
                    type="button"
                    aria-label={`delete mission ${m.title ?? ""}`}
                    onClick={() => setDeletingId(m.id)}
                    className="px-1.5 py-1 font-mono text-[0.62rem] text-ink-dim hover:text-warn"
                  >
                    ✕
                  </button>
                </span>
              ),
            )}
          </div>
        ) : null}

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            {receiptId ? <GhostReceipt vaultKey={vaultKey} missionId={receiptId} /> : null}

            {messages.length === 0 ? (
              <div className="flex flex-col items-center gap-5 pb-2 pt-8 text-center">
                <span className="grid h-12 w-12 place-items-center overflow-hidden rounded-full border border-line-strong bg-black">
                  <Image src="/brand/logo.jpg" alt="" width={48} height={48} className="scale-[1.5] object-contain" />
                </span>
                <div>
                  <h2 className="text-2xl font-medium tracking-tight">What should I get done?</h2>
                  <p className="mx-auto mt-2 max-w-md font-mono text-xs leading-5 text-ink-dim">
                    describe a task. i research the public web under your privacy rules, compare what
                    matters, and never share your real data without approval.
                  </p>
                </div>
                <div className="flex w-full max-w-xl flex-col gap-2">
                  {EXAMPLES.map((example) => (
                    <button
                      key={example}
                      type="button"
                      onClick={() => setInput(example)}
                      className="rounded-lg border border-line px-4 py-3 text-left font-mono text-xs text-ink-dim transition-colors hover:border-accent hover:text-accent"
                    >
                      {example}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m, i) =>
                m.role === "you" ? (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl border border-line bg-bg-raised px-4 py-2.5 text-sm leading-6 text-ink">
                      {m.text}
                    </div>
                  </div>
                ) : (
                  <div key={i} className="flex gap-3">
                    <Avatar />
                    <div className="flex min-w-0 flex-1 flex-col gap-3">
                      {m.text ? (
                        <p className="whitespace-pre-wrap text-sm leading-6 text-ink">{m.text}</p>
                      ) : null}
                      {m.recommendations ? (
                        <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2">
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
                                  className="mt-2 inline-block max-w-full truncate font-mono text-xs text-accent hover:underline"
                                >
                                  {r.url}
                                </a>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {m.purchases ? (
                        <div className="grid gap-px overflow-hidden rounded-lg border border-accent/40 bg-line sm:grid-cols-2">
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
                  </div>
                ),
              )
            )}

            {busy ? (
              <div className="flex items-center gap-3">
                <Avatar />
                <div className="flex items-center gap-2 font-mono text-xs text-ink-dim">
                  <TypingDots />
                  researching…
                </div>
              </div>
            ) : null}

            {error ? (
              <div className="rounded-lg border border-warn bg-bg px-4 py-2.5 font-mono text-xs text-warn">
                {error}
              </div>
            ) : null}
          </div>
        </div>

        {/* decision bars sit right above the composer, like a modal answer in chat */}
        {purchaseAsk ? (
          <div className="border-t border-line bg-bg-raised px-4 py-3">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
              <p className="font-mono text-[0.62rem] tracking-widest text-accent uppercase">purchase confirmation</p>
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
                  className="inline-flex min-h-10 items-center rounded-md bg-accent px-3 font-mono text-xs text-bg uppercase transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  confirm purchase
                </button>
                <button
                  type="button"
                  onClick={() => submitPurchase("cancel")}
                  disabled={busy}
                  className="inline-flex min-h-10 items-center rounded-md border border-line px-3 font-mono text-xs text-ink-dim uppercase transition-colors hover:border-accent"
                >
                  cancel
                </button>
              </div>
              <p className="font-mono text-[0.58rem] text-ink-dim">
                nothing is ordered until you confirm — you pay the invoice from your own wallet.
              </p>
            </div>
          </div>
        ) : permission ? (
          <form onSubmit={submitDecision} className="border-t border-line bg-bg-raised px-4 py-3">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
              <p className="font-mono text-[0.62rem] tracking-widest text-accent uppercase">privacy check</p>
              <p className="font-mono text-sm text-ink">
                the agent wants your{" "}
                <span className="text-accent">{FIELD_LABELS[permission.field] ?? permission.field}</span>
                <span className="text-ink-dim"> — {permission.reason}</span>
              </p>
              <div className="flex flex-wrap gap-2">
                {(["approve", ...(permission.has_alias ? ["alias" as const] : []), "deny"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDecision(d)}
                    className={`inline-flex min-h-11 items-center rounded-md border px-3 font-mono text-xs uppercase transition-colors ${
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
                  <p className="font-mono text-[0.58rem] text-ink-dim">
                    the value is logged as shared in the receipt and never stored
                  </p>
                </>
              ) : null}
              <div>
                <button type="submit" disabled={busy || (decision === "approve" && !value.trim())} className="btn btn-sm">
                  send decision
                </button>
              </div>
            </div>
          </form>
        ) : null}

        {/* composer */}
        <div className="border-t border-line bg-bg px-4 py-3">
          <form onSubmit={submit} className="mx-auto flex w-full max-w-3xl items-center gap-2">
            <input
              id="ghost-input"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={permission || purchaseAsk ? "decide above to continue…" : "message the ghost agent…"}
              maxLength={2000}
              disabled={busy || !!permission || !!purchaseAsk}
              className="field min-h-11 flex-1 rounded-full px-4"
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={busy || !input.trim() || !!permission || !!purchaseAsk}
              aria-label="send"
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent font-mono text-lg text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              ↑
            </button>
          </form>
          <p className="mx-auto mt-2 max-w-3xl text-center font-mono text-[0.58rem] leading-4 text-ink-dim">
            searches and page fetches are server-side and logged. real personal data needs your
            approval. the ghost receipt shows exactly what happened.
          </p>
        </div>
      </section>
    </div>
  );
}
