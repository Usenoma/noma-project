"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import useSWR, { useSWRConfig } from "swr";
import { getOrder } from "@/lib/api";
import { fromRaw } from "@/lib/format";
import { Countdown } from "./Countdown";
import { MonoBlock } from "./MonoBlock";
import { QrBlock } from "./QrBlock";
import { StateWord } from "./StateWord";

// Wallet payment is a convenience on top of manual payment (address + QR). It carries
// wagmi/viem, so it is loaded only after the user asks for it — order pages stay light.
const PayButton = dynamic(() => import("./PayButton").then((m) => m.PayButton), {
  ssr: false,
  loading: () => null,
});

// The checkout figure: locked price, TTL countdown, payment address, QR, and one-click pay.
// Polls the order while payment is pending.
export function InvoicePanel({
  orderId,
  orderKey,
  walletToken,
}: {
  orderId: string;
  orderKey?: string;
  walletToken?: string;
}) {
  const { mutate } = useSWRConfig();
  const cacheKey = ["order", orderId, orderKey ? "key" : "", walletToken ? walletToken.slice(-10) : ""];
  const { data: order } = useSWR(
    cacheKey,
    () => getOrder(orderId, orderKey, walletToken),
    {
      refreshInterval: (latest) =>
        latest && ["delivered", "expired", "failed", "refunded"].includes(latest.status)
          ? 0
          : 5_000,
    },
  );

  const [payWanted, setPayWanted] = useState(false);

  const invoice = order?.invoice;
  const decimals = invoice?.asset === "USDG" ? 6 : 18;
  const payable = invoice?.status === "pending" || invoice?.status === "seen";

  return (
    <div className="border border-line bg-bg-raised">
      <div className="flex items-baseline justify-between border-b border-line px-4 py-2">
        <span className="font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
          fig. — the invoice
        </span>
        {order ? <StateWord key={order.status} state={order.status} /> : null}
      </div>
      <div className="flex flex-col gap-4 p-4">
        {!order || !invoice ? (
          <p className="font-mono text-sm text-ink-dim">loading invoice…</p>
        ) : (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-ink-dim">amount</span>
              <span className="tnum font-mono text-2xl">
                {fromRaw(invoice.amount, decimals)} {invoice.asset}
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-ink-dim">price locked</span>
              <span className="tnum font-mono text-sm">${order.price_usd}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-ink-dim">expires</span>
              {invoice.status === "expired" ? (
                <span className="font-mono text-sm text-ink-dim">expired</span>
              ) : (
                <Countdown to={invoice.expires_at} prefix="in" />
              )}
            </div>

            {invoice.status === "underpaid" ? (
              <div className="border border-warn bg-bg px-3 py-2 font-mono text-xs leading-5 text-warn">
                <p>
                  underpaid — received {fromRaw(invoice.received ?? "0", decimals)} of{" "}
                  {fromRaw(invoice.amount, decimals)} {invoice.asset}.
                </p>
                <p className="mt-1 text-ink-dim">
                  do not send the full invoice again. automatic refunds are disabled; report the
                  payment and support will resolve the shortfall.
                </p>
              </div>
            ) : invoice.status === "expired" || invoice.status === "late_paid" ? (
              <p className="border border-line bg-bg px-3 py-2 font-mono text-xs text-ink-dim">
                {invoice.status === "late_paid"
                  ? "paid late — automatic refunds are disabled; contact support. do not pay again."
                  : "do not pay — expired. create a new invoice from the product page."}
              </p>
            ) : (
              <>
                <div>
                  <div className="mb-1.5 font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
                    send exactly
                  </div>
                  <MonoBlock value={`${fromRaw(invoice.amount, decimals)} ${invoice.asset}`} className="w-full" />
                </div>
                <div>
                  <div className="mb-1.5 font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
                    to address
                  </div>
                  <MonoBlock value={invoice.pay_to} className="w-full" />
                </div>
                <div className="flex justify-center py-2">
                  <QrBlock value={invoice.pay_to} size={200} />
                </div>
                {payable ? (
                  payWanted ? (
                    <PayButton invoice={invoice} decimals={decimals} onPaid={() => mutate(cacheKey)} />
                  ) : (
                    <button type="button" onClick={() => setPayWanted(true)} className="btn w-full">
                      pay {fromRaw(invoice.amount, decimals)} {invoice.asset} from wallet
                    </button>
                  )
                ) : null}
              </>
            )}

            {invoice.tx_hash ? (
              <div className="flex items-baseline justify-between border-t border-line pt-3">
                <span className="text-sm text-ink-dim">payment tx</span>
                <span className="tnum font-mono text-xs">{invoice.tx_hash.slice(0, 18)}…</span>
              </div>
            ) : null}
            <p className="text-xs text-ink-dim">
              the amount is unique to this invoice — send exactly it. Payments go wallet-to-wallet;
              no account is created.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
