"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { ApiError, createPaymentClaim, getOrder, revokeAiKey, rotateAiKey } from "@/lib/api";
import { dateTime, fromRaw, usd } from "@/lib/format";
import { readOrderKey, recallOrder, writeOrderKey } from "@/lib/orderKey";
import { getWalletSession } from "@/lib/walletSession";
import type { OrderView as OrderViewData } from "@/lib/types";
import { DeliverablePanel } from "./DeliverablePanel";
import { EmptyState } from "./EmptyState";
import { InvoicePanel } from "./InvoicePanel";
import { StateWord } from "./StateWord";
import { Stepper } from "./Stepper";
import { TxLink } from "./TxLink";

const STEPS = ["created", "paid", "fulfilled", "delivered"];
const STEP_INDEX: Record<string, number> = {
  created: 0,
  awaiting_payment: 0,
  paid: 1,
  fulfilling: 2,
  delivered: 3,
};

const LIVE_STATES = ["awaiting_payment", "paid", "fulfilling", "refunding"];

export function OrderView({
  orderId,
  initialKey,
  walletToken,
  embedded = false,
}: {
  orderId: string;
  initialKey?: string | null;
  walletToken?: string | null;
  embedded?: boolean;
}) {
  // The key lives in the URL fragment (client-only). Lazy initializer reads it once on mount.
  const [orderKey, setOrderKey] = useState<string | null>(() => {
    if (initialKey) return initialKey;
    if (typeof window === "undefined") return null;
    return readOrderKey() ?? recallOrder(orderId);
  });

  // undefined → use the read-only wallet session from this tab; null → no wallet auth.
  const token =
    walletToken !== undefined
      ? walletToken
      : typeof window === "undefined"
        ? null
        : (getWalletSession()?.token ?? null);

  const { data: order, error, mutate: refresh } = useSWR(
    ["order", orderId, orderKey, token ? token.slice(-10) : null],
    () => getOrder(orderId, orderKey ?? undefined, token ?? undefined),
    {
      refreshInterval: (latest) =>
        latest && LIVE_STATES.includes(latest.status) ? 5_000 : 0,
    },
  );

  const unauthorized = error instanceof ApiError && error.status === 401;

  function submitKey(key: string) {
    const next = key.trim();
    if (!next) return;
    writeOrderKey(next);
    setOrderKey(next);
  }

  if (error && !order) {
    if (unauthorized) {
      return (
        <div className={embedded ? "flex flex-col gap-6" : "mx-auto flex max-w-3xl flex-col gap-6"}>
          <div className="rule-label">order</div>
          <KeyGate
            onSubmit={submitKey}
            message="This order is locked. Enter the order key shown at checkout, or sign in with the wallet that paid for it."
          />
        </div>
      );
    }
    return <EmptyState line="no order with this id" action={{ href: "/market", label: "back to market" }} />;
  }
  if (!order) {
    return <p className="font-mono text-sm text-ink-dim">loading order…</p>;
  }

  const stepIndex = STEP_INDEX[order.status] ?? 0;
  const failed = ["failed", "refunding", "refunded", "expired"].includes(order.status);

  return (
    <div className={embedded ? "flex flex-col gap-8" : "mx-auto flex max-w-3xl flex-col gap-8"}>
      <div>
        <div className="rule-label">order</div>
        <div className="mt-3 flex flex-wrap items-baseline justify-between gap-4">
          <h1 className="text-3xl font-medium tracking-[-0.04em] sm:text-4xl">{order.title}</h1>
          <StateWord key={order.status} state={order.status} size="lg" />
        </div>
        <p className="tnum mt-1 font-mono text-xs text-ink-dim">
          {order.id} · created {dateTime(order.created_at)} · {usd(order.price_usd)}
        </p>
      </div>

      {!failed ? <Stepper steps={STEPS} current={stepIndex} /> : null}

      {order.status === "fulfilling" ? (
        <p className="border-l-2 border-warn bg-bg-raised px-4 py-3 font-mono text-sm text-warn">
          fulfilling · the supplier is provisioning your order
        </p>
      ) : null}
      {order.status === "refunding" || order.status === "refunded" ? (
        <p className="border-l-2 border-bad bg-bg-raised px-4 py-3 font-mono text-sm text-bad">
          {order.status === "refunded"
            ? "refunded — the funds were returned to the payer address"
            : "refunding — the refund is being sent on-chain"}
        </p>
      ) : null}

      {order.invoice?.tx_hash ? (
        <div className="flex items-baseline justify-between border border-line bg-bg-raised px-4 py-3">
          <span className="text-sm text-ink-dim">payment tx</span>
          <TxLink hash={order.invoice.tx_hash} confirmations={order.invoice.confirmations} />
        </div>
      ) : null}

      <PaymentCorrections
        orderId={order.id}
        order={order}
        orderKey={orderKey}
        token={token}
        onChanged={() => void refresh()}
      />

      {order.status === "awaiting_payment" || order.status === "created" ? (
        <InvoicePanel
          orderId={order.id}
          orderKey={orderKey ?? undefined}
          walletToken={token ?? undefined}
        />
      ) : null}

      {/* Deliverables are returned only after the backend authorizes the key or the wallet. */}
      {order.deliverables.length > 0 ? (
        <DeliverablePanel deliverables={order.deliverables} />
      ) : order.status === "delivered" ? (
        <KeyGate
          onSubmit={submitKey}
          message="The deliverable is shown only to the order key holder or the wallet that paid for it."
        />
      ) : null}

      {order.deliverables.some((d) => d.type === "api_key") ? (
        <AiKeyActions
          orderId={order.id}
          orderKey={orderKey}
          token={token}
          onChanged={() => void refresh()}
        />
      ) : null}
    </div>
  );
}

function PaymentCorrections({
  orderId,
  order,
  orderKey,
  token,
  onChanged,
}: {
  orderId: string;
  order: {
    invoice: OrderViewData["invoice"];
    refunds: OrderViewData["refunds"];
    payment_claims: OrderViewData["payment_claims"];
  };
  orderKey: string | null;
  token: string | null;
  onChanged: () => void;
}) {
  const invoice = order.invoice;
  const decimals = invoice?.asset === "USDG" ? 6 : 18;
  const [txHash, setTxHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reported, setReported] = useState(false);

  if (!invoice && order.refunds.length === 0 && order.payment_claims.length === 0) return null;

  const received = BigInt(invoice?.received ?? "0");
  const amount = BigInt(invoice?.amount ?? "0");
  const shortfall = amount > received ? amount - received : 0n;
  const underpaid = invoice?.status === "underpaid";
  const late = invoice?.status === "late_paid";
  const canReport = Boolean(invoice) && ["pending", "seen", "underpaid", "expired", "late_paid"].includes(invoice!.status);

  async function report(e: React.FormEvent) {
    e.preventDefault();
    const hash = txHash.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash) || busy) {
      setError("enter the transaction hash (0x…)");
      return;
    }
    setBusy(true);
    setError(null);
    setReported(false);
    try {
      await createPaymentClaim(orderId, hash, orderKey ?? undefined, token ?? undefined);
      setTxHash("");
      setReported(true);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not report the payment");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {underpaid ? (
        <div className="border-l-2 border-warn bg-bg-raised px-4 py-3 font-mono text-sm leading-6 text-warn">
          <p>
            underpaid — received {fromRaw(invoice!.received ?? "0", decimals)} of{" "}
            {fromRaw(invoice!.amount, decimals)} {invoice!.asset}
            {shortfall > 0n ? ` · shortfall ${fromRaw(shortfall.toString(), decimals)} ${invoice!.asset}` : ""}.
          </p>
          <p className="text-xs text-ink-dim">
            do not send the full invoice again. automatic refunds are disabled; report the
            transaction below and support will resolve the shortfall.
          </p>
        </div>
      ) : null}
      {late ? (
        <p className="border-l-2 border-warn bg-bg-raised px-4 py-3 font-mono text-sm text-warn">
          paid after expiry — automatic refunds are disabled; contact support.
        </p>
      ) : null}

      {order.refunds.length > 0 ? (
        <div className="border border-line bg-bg-raised p-4">
          <div className="rule-label">refunds</div>
          <div className="mt-2 flex flex-col gap-2 font-mono text-xs">
            {order.refunds.map((refund) => (
              <div key={refund.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-ink-dim">
                  {refund.kind} · {fromRaw(refund.amount, refund.asset === "USDG" ? 6 : 18)} {refund.asset}
                </span>
                <span className={refund.status === "confirmed" ? "text-good" : refund.status === "failed" ? "text-bad" : "text-warn"}>
                  {refund.status}
                </span>
                {refund.tx_hash ? (
                  <TxLink hash={refund.tx_hash} confirmations={invoice?.confirmations ?? 0} />
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {order.payment_claims.length > 0 ? (
        <div className="border border-line bg-bg-raised p-4">
          <div className="rule-label">reported payments</div>
          <div className="mt-2 flex flex-col gap-2 font-mono text-xs">
            {order.payment_claims.map((claim) => (
              <div key={claim.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-ink-dim">
                  {claim.asset.replace(/^TOKEN:/, "token ")} · {claim.amount} · {dateTime(claim.created_at)}
                </span>
                <span
                  className={
                    claim.status === "accepted"
                      ? "text-good"
                      : claim.status === "rejected"
                        ? "text-bad"
                        : "text-warn"
                  }
                >
                  {claim.status}
                </span>
                <TxLink hash={claim.tx_hash} confirmations={0} />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {canReport ? (
        <form onSubmit={report} className="border border-line bg-bg-raised p-4">
          <div className="rule-label">payment not showing?</div>
          <p className="mt-2 text-xs text-ink-dim">
            report a transaction you sent to the payment address. the server verifies it on-chain; an
            operator resolves it. never share a private key.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={txHash}
              onChange={(e) => setTxHash(e.target.value)}
              placeholder="0x… transaction hash"
              spellCheck={false}
              className="field min-w-0 flex-1"
            />
            <button type="submit" disabled={busy} className="btn sm:w-auto">
              {busy ? "checking…" : "report"}
            </button>
          </div>
          {reported ? (
            <p className="mt-2 font-mono text-xs text-good">
              reported — an operator will review the payment.
            </p>
          ) : null}
          {error ? <p className="mt-2 font-mono text-xs text-bad">{error}</p> : null}
        </form>
      ) : null}
    </div>
  );
}

function AiKeyActions({
  orderId,
  orderKey,
  token,
  onChanged,
}: {
  orderId: string;
  orderKey: string | null;
  token: string | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<"rotate" | "revoke" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: "rotate" | "revoke") {
    if (busy) return;
    const question =
      action === "rotate"
        ? "Rotate this API key? The current key stops working immediately."
        : "Revoke this API key? It stops working immediately; remaining credit is kept for a later rotation.";
    if (!window.confirm(question)) return;
    setBusy(action);
    setError(null);
    try {
      if (action === "rotate") await rotateAiKey(orderId, orderKey ?? undefined, token ?? undefined);
      else await revokeAiKey(orderId, orderKey ?? undefined, token ?? undefined);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : `could not ${action} the key`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border border-line bg-bg-raised p-4">
      <div className="rule-label">api key controls</div>
      <p className="mt-2 text-xs text-ink-dim">
        rotate if the key was shared or exposed; revoke to disable it. both actions need the order key
        or the wallet that paid — no account is involved.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => run("rotate")}
          disabled={busy !== null}
          className="border border-line px-3 py-2 font-mono text-xs tracking-widest uppercase hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {busy === "rotate" ? "rotating…" : "rotate key"}
        </button>
        <button
          type="button"
          onClick={() => run("revoke")}
          disabled={busy !== null}
          className="border border-line px-3 py-2 font-mono text-xs tracking-widest text-bad uppercase hover:border-bad disabled:opacity-50"
        >
          {busy === "revoke" ? "revoking…" : "revoke key"}
        </button>
      </div>
      {error ? <p className="mt-2 font-mono text-xs text-bad">{error}</p> : null}
    </div>
  );
}

function KeyGate({ onSubmit, message }: { onSubmit: (key: string) => void; message: string }) {
  const [value, setValue] = useState("");

  return (
    <div className="border border-line bg-bg-raised p-4">
      <p className="font-mono text-sm text-ink-dim">{message}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(value);
        }}
        className="mt-4 flex flex-col gap-2"
      >
        <label htmlFor="order-key" className="field-label">
          order key
        </label>
        <div className="flex gap-2">
          <input
            id="order-key"
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="paste order key"
            className="field min-w-0 flex-1"
          />
          <button
            type="submit"
            className="inline-flex min-h-11 items-center border border-line px-4 font-mono text-sm text-ink-dim transition-colors hover:border-accent hover:text-accent"
          >
            open
          </button>
        </div>
      </form>
      <p className="mt-3 text-xs text-ink-dim">
        Lost the key? An anonymous order cannot be recovered — that is the cost of no accounts. If a
        wallet paid for it, open the{" "}
        <Link href="/orders" className="text-accent hover:underline">
          orders vault
        </Link>{" "}
        and sign with that wallet.
      </p>
    </div>
  );
}
