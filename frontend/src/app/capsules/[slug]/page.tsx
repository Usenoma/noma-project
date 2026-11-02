"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import useSWR from "swr";
import Link from "next/link";
import { useAccount, useSignMessage } from "wagmi";
import { buyCapsule, getCapsule } from "@/lib/api";
import { FEATURES } from "@/lib/features";
import { fromRaw, usd } from "@/lib/format";
import type { CapsuleOrderResult, PayAsset, RequiredField } from "@/lib/types";
import { rememberOrder } from "@/lib/orderKey";
import { getWalletSession, walletAuthMessage } from "@/lib/walletSession";
import { EmptyState } from "@/components/EmptyState";
import { InvoicePanel } from "@/components/InvoicePanel";
import { KeyMoment } from "@/components/KeyMoment";
import { SegmentedControl } from "@/components/SegmentedControl";
import { WalletScope } from "@/components/WalletScope";

export default function CapsulePage() {
  return (
    <WalletScope>
      <CapsuleInner />
    </WalletScope>
  );
}

function CapsuleInner() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const { address } = useAccount();
  const { signMessageAsync, isPending: signing } = useSignMessage();
  const { data: capsule, error } = useSWR(
    FEATURES.capsules && slug ? ["capsule", slug] : null,
    () => getCapsule(slug),
  );

  const [fields, setFields] = useState<Record<string, string>>({});
  const [payAsset, setPayAsset] = useState<PayAsset>("USDG");
  const [attachWallet, setAttachWallet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<CapsuleOrderResult | null>(null);
  const [saved, setSaved] = useState(false);

  // Union of required fields across items, deduplicated by name.
  const required = useMemo(() => {
    const map = new Map<string, RequiredField>();
    for (const item of capsule?.items ?? []) {
      for (const f of item.product?.required_fields ?? []) {
        if (!map.has(f.name)) map.set(f.name, f);
      }
    }
    return [...map.values()];
  }, [capsule]);

  if (!FEATURES.capsules) {
    return <EmptyState line="capsules are not available yet" action={{ href: "/market", label: "browse the market" }} />;
  }
  if (error) {
    return <EmptyState line="capsule unavailable" action={{ href: "/capsules", label: "all capsules" }} />;
  }
  if (!capsule) {
    return <p className="font-mono text-sm text-ink-dim">loading capsule…</p>;
  }

  async function buy(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const proof =
        attachWallet && address
          ? await attachProof(address)
          : undefined;
      const res = await buyCapsule(
        capsule!.slug,
        fields,
        payAsset,
        proof ? { wallet: address, ...proof } : undefined,
      );
      setResult(res);
      setSaved(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "capsule purchase failed");
    } finally {
      setBusy(false);
    }
  }

  // Reuse the vault session when it belongs to this wallet; otherwise one signature proves the
  // wallet before the capsule orders are attached to it.
  async function attachProof(address: string) {
    const session = getWalletSession();
    if (session && session.address.toLowerCase() === address.toLowerCase()) {
      return { token: session.token };
    }
    const timestamp = Date.now();
    const signature = await signMessageAsync({ message: walletAuthMessage(address, timestamp) });
    return { address, signature, timestamp };
  }

  if (result) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <div>
          <div className="rule-label">capsule</div>
          <h1 className="mt-3 text-2xl font-medium tracking-tight">{capsule.title} — orders created</h1>
          <p className="mt-1 text-sm text-ink-dim">
            One order per item. Save each order key; pay each invoice to receive that item.
          </p>
        </div>
        {result.orders.map((o) => (
          <div key={o.order_id} className="border border-line bg-bg-raised p-4">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-sm">{o.item}</span>
              <span className="tnum font-mono text-sm text-accent">
                {fromRaw(o.invoice.amount, o.invoice.asset === "USDG" ? 6 : 18)} {o.invoice.asset}
              </span>
            </div>
            <div className="mt-3">
              <KeyMoment orderId={o.order_id} orderKey={o.order_key} />
            </div>
            <div className="mt-4">
              <InvoicePanel orderId={o.order_id} orderKey={o.order_key} />
            </div>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn"
            onClick={() => {
              for (const o of result.orders) rememberOrder(o.order_id, o.order_key);
              setSaved(true);
            }}
          >
            {saved ? "saved on this device" : "remember all on this device"}
          </button>
          <Link href="/orders" className="font-mono text-sm text-accent hover:underline">
            open the orders vault →
          </Link>
        </div>
        <p className="font-mono text-xs text-ink-dim">
          each item is its own order with its own invoice. a failed item refunds only itself; the
          other items stay.
        </p>
        <Link href="/capsules" className="font-mono text-sm text-accent hover:underline">
          ← all capsules
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={buy} className="flex max-w-3xl flex-col gap-8">
      <div>
        <div className="rule-label">capsule</div>
        <h1 className="mt-3 text-3xl font-medium tracking-tight">{capsule.title}</h1>
        <p className="mt-2 max-w-xl text-sm text-ink-dim">{capsule.outcome}</p>
      </div>

      <div className="border border-line">
        <div className="border-b border-line px-4 py-2 font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
          included
        </div>
        <div className="divide-y divide-line">
          {capsule.items.map((i) => (
            <div key={i.category} className="flex items-baseline justify-between px-4 py-3">
              <div>
                <div className="text-sm">{i.title}</div>
                <div className="font-mono text-xs text-ink-dim">
                  {i.product ? `${i.product.title}` : "unavailable"}
                </div>
              </div>
              <span className="tnum font-mono text-sm">{i.product ? usd(i.product.price_usd) : "—"}</span>
            </div>
          ))}
          <div className="flex items-baseline justify-between px-4 py-3">
            <span className="font-mono text-sm text-ink-dim">total</span>
            <span className="tnum font-mono text-lg">{usd(capsule.total_usd)}</span>
          </div>
        </div>
      </div>

      {required.length > 0 ? (
        <div className="flex flex-col gap-4">
          <div className="font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
            what the capsule needs
          </div>
          {required.map((f) => (
            <div key={f.name}>
              <label
                htmlFor={`capsule-${f.name}`}
                className="mb-1.5 block font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase"
              >
                {f.label}
                {f.optional ? " · optional" : ""}
              </label>
              {f.type === "select" ? (
                <select
                  id={`capsule-${f.name}`}
                  value={fields[f.name] ?? ""}
                  onChange={(e) => setFields({ ...fields, [f.name]: e.target.value })}
                  className="w-full border border-line bg-bg px-3 py-2 font-mono text-sm text-ink focus:border-accent focus:outline-none"
                >
                  <option value="">—</option>
                  {(f.options ?? []).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`capsule-${f.name}`}
                  type={f.type === "email" ? "email" : f.type === "number" ? "number" : "text"}
                  value={fields[f.name] ?? ""}
                  onChange={(e) => setFields({ ...fields, [f.name]: e.target.value })}
                  className="w-full border border-line bg-bg px-3 py-2 font-mono text-sm text-ink focus:border-accent focus:outline-none"
                />
              )}
            </div>
          ))}
        </div>
      ) : null}

      <SegmentedControl
        label="pay with"
        options={[
          { value: "USDG" as PayAsset, label: "USDG" },
          { value: "ETH" as PayAsset, label: "ETH" },
        ]}
        value={payAsset}
        onChange={setPayAsset}
      />

      {address ? (
        <label className="flex items-center gap-2 font-mono text-xs text-ink-dim">
          <input
            type="checkbox"
            checked={attachWallet}
            onChange={(e) => setAttachWallet(e.target.checked)}
            className="accent-accent"
          />
          attach these orders to my wallet — we ask for one signature
        </label>
      ) : null}

      {submitError ? <p className="font-mono text-sm text-bad">{submitError}</p> : null}

      <button
        type="submit"
        disabled={busy || signing || !capsule.available}
        className="btn"
      >
        {busy || signing ? "confirm in wallet…" : `Buy the capsule · ${usd(capsule.total_usd)}`}
      </button>
    </form>
  );
}
