"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { useAccount, useSignMessage } from "wagmi";
import { createOrder, getProduct, previewAliases } from "@/lib/api";
import { categoryLabel, specLine, usd } from "@/lib/format";
import { FEATURES } from "@/lib/features";
import type { AliasPreview, CreateOrderResponse, PayAsset } from "@/lib/types";
import { orderUrl, rememberOrder, writeOrderKey } from "@/lib/orderKey";
import { getWalletSession, walletAuthMessage } from "@/lib/walletSession";
import { EmptyState } from "./EmptyState";
import { ExposureReceipt } from "./ExposureReceipt";
import { InvoicePanel } from "./InvoicePanel";
import { KeyMoment } from "./KeyMoment";
import { SegmentedControl } from "./SegmentedControl";

const FIELD_HINTS: Record<string, string> = {
  email: "the deliverable is sent here",
  username: "your account username",
  country: "the country the service is provisioned for",
};

export function CheckoutFlow() {
  const params = useSearchParams();
  // Capture the product once: after the invoice is created the address bar is rewritten to the
  // order URL (key in the fragment), which drops ?product=. Reading searchParams live would then
  // flip this component to the "no product selected" state and hide the invoice.
  const [productId] = useState(() => params.get("product") ?? "");
  const { address } = useAccount();
  const { signMessageAsync, isPending: signing } = useSignMessage();

  const { data: product, error } = useSWR(
    productId ? ["product", productId] : null,
    () => getProduct(productId),
  );

  const [fields, setFields] = useState<Record<string, string>>({});
  const [payAsset, setPayAsset] = useState<PayAsset>("USDG");
  const [attachWallet, setAttachWallet] = useState(false);
  const [remember, setRemember] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateOrderResponse | null>(null);
  const [ghostMode, setGhostMode] = useState(false);
  const [aliases, setAliases] = useState<AliasPreview[]>([]);

  if (!productId) {
    return <EmptyState line="no product selected" action={{ href: "/market", label: "browse the market" }} />;
  }
  if (error) {
    return <EmptyState line="product unavailable" action={{ href: "/market", label: "back to market" }} />;
  }
  if (!product) {
    return <p className="font-mono text-sm text-ink-dim">loading checkout…</p>;
  }
  if (!product.available) {
    return (
      <EmptyState
        line="supplier is out of stock — try again later"
        action={{ href: "/market", label: "back to market" }}
      />
    );
  }

  // Attaching the order is an identity claim. Reuse the read-only vault session when it belongs to
  // this wallet; otherwise ask for one signature (no transaction, no gas).
  async function attachProof(address: string) {
    const session = getWalletSession();
    if (session && session.address.toLowerCase() === address.toLowerCase()) {
      return { token: session.token };
    }
    const timestamp = Date.now();
    const signature = await signMessageAsync({ message: walletAuthMessage(address, timestamp) });
    return { address, signature, timestamp };
  }

  function validate(): boolean {
    const errors: Record<string, string> = {};
    for (const f of product!.required_fields) {
      const v = (fields[f.name] ?? "").trim();
      if (!f.optional && !v) {
        errors[f.name] = "required";
        continue;
      }
      if (v && f.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
        errors[f.name] = "not a valid email";
      }
      if (v && f.type === "number" && Number.isNaN(Number(v))) {
        errors[f.name] = "not a number";
      }
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate() || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Ghost Checkout (gated): the supplier receives per-order aliases, not the buyer's details.
      let sendFields = fields;
      if (FEATURES.ghostCheckout && ghostMode) {
        const preview = await previewAliases(product!.id, fields);
        sendFields = preview.fields;
        setAliases(preview.aliases);
      }
      const res = await createOrder({
        product_id: product!.id,
        fields: sendFields,
        pay_asset: payAsset,
        wallet: attachWallet && address ? address : undefined,
        walletAuth:
          attachWallet && address
            ? await attachProof(address)
            : undefined,
      });
      setCreated(res);
      writeOrderKey(res.order_key);
      if (remember) rememberOrder(res.order_id, res.order_key);
      // Keep the buyer on the invoice, but make the address bar a valid order URL: a refresh
      // opens the order page with the key in the fragment instead of a 404.
      window.history.replaceState(null, "", orderUrl(res.order_id, res.order_key));
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "order creation failed");
    } finally {
      setSubmitting(false);
    }
  }

  // Phase 2: invoice created — show order key + invoice panel.
  if (created) {
    return (
      <div className="grid gap-8 lg:grid-cols-[1fr_400px]">
        <div className="flex max-w-2xl flex-col gap-6">
          <div>
            <div className="rule-label">checkout</div>
            <h1 className="mt-4 text-3xl tracking-[-0.04em]">{product.title}</h1>
          </div>
          <KeyMoment orderId={created.order_id} orderKey={created.order_key} />
          {aliases.length > 0 ? (
            <div className="border border-line p-3 font-mono text-xs">
              <div className="mb-2 tracking-widest text-ink-dim uppercase">sent as</div>
              {aliases.map((a) => (
                <div key={a.field} className="flex items-baseline justify-between gap-4 py-0.5">
                  <span className="text-ink-dim">{a.label}</span>
                  <span className="text-right">
                    {a.aliased ? `${a.real} → ${a.sent}` : `${a.real} (delivery)`}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <label className="flex items-center gap-2 font-mono text-xs text-ink-dim">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => {
                setRemember(e.target.checked);
                if (e.target.checked) rememberOrder(created.order_id, created.order_key);
              }}
              className="accent-accent"
            />
            remember this order on this device
          </label>
          <a
            href={orderUrl(created.order_id, created.order_key)}
            className="font-mono text-sm text-accent hover:underline"
          >
            go to the order page →
          </a>
        </div>
        <InvoicePanel orderId={created.order_id} orderKey={created.order_key} />
      </div>
    );
  }

  // Phase 1: collect fields + pay asset.
  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_400px]">
      <div className="max-w-2xl">
        <div className="rule-label">checkout</div>
        <h1 className="mt-4 text-3xl tracking-[-0.04em]">{product.title}</h1>
        <p className="mt-2 font-mono text-xs text-ink-dim">
          {categoryLabel(product.category)}
          {product.region ? ` · ${product.region}` : ""}
          {specLine(product.category, product.specs)
            ? ` · ${specLine(product.category, product.specs)}`
            : ""}
        </p>

        <form onSubmit={submit} className="mt-8 flex flex-col gap-5">
          {product.required_fields.map((f) => (
            <div key={f.name}>
              <label
                htmlFor={`field-${f.name}`}
                className="field-label"
              >
                {f.label}
                {f.optional ? " · optional" : ""}
              </label>
              {f.type === "select" ? (
                <select
                  id={`field-${f.name}`}
                  value={fields[f.name] ?? ""}
                  onChange={(e) => setFields({ ...fields, [f.name]: e.target.value })}
                  className="field"
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
                  id={`field-${f.name}`}
                  type={f.type === "email" ? "email" : f.type === "number" ? "number" : "text"}
                  value={fields[f.name] ?? ""}
                  onChange={(e) => setFields({ ...fields, [f.name]: e.target.value })}
                  className="field"
                />
              )}
              {FIELD_HINTS[f.name] ? (
                <p className="mt-1 text-xs text-ink-dim">{FIELD_HINTS[f.name]}</p>
              ) : null}
              {fieldErrors[f.name] ? (
                <p className="mt-1 font-mono text-xs text-bad">{fieldErrors[f.name]}</p>
              ) : null}
            </div>
          ))}

          <ExposureReceipt product={product} values={fields} />

          {FEATURES.ghostCheckout ? (
            <label className="flex items-center gap-2 font-mono text-xs text-ink-dim">
              <input
                type="checkbox"
                checked={ghostMode}
                onChange={(e) => setGhostMode(e.target.checked)}
                className="accent-accent"
              />
              ghost mode — send aliases instead of your details (delivery email stays real)
            </label>
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
              attach this order to my wallet — we ask for one signature
            </label>
          ) : null}

          <label className="flex items-center gap-2 font-mono text-xs text-ink-dim">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="accent-accent"
            />
            remember this order on this device
          </label>

          {submitError ? <p className="font-mono text-sm text-bad">{submitError}</p> : null}

          <button
            type="submit"
            disabled={submitting || signing}
            className="btn mt-2"
          >
            {submitting || signing
              ? "confirm in wallet…"
              : `Create invoice · ${usd(product.price_usd)}`}
          </button>
        </form>
      </div>

      <aside>
        <div className="panel p-6">
          <div className="font-mono text-[0.62rem] tracking-[0.16em] text-ink-dim uppercase">
            summary
          </div>
          <div className="mt-4 flex items-baseline justify-between">
            <span className="text-sm text-ink-dim">price</span>
            <span className="display tnum text-2xl">{usd(product.price_usd)}</span>
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="text-sm text-ink-dim">price lock</span>
            <span className="tnum font-mono text-sm">15 min</span>
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="text-sm text-ink-dim">network</span>
            <span className="font-mono text-sm">robinhood chain</span>
          </div>
          <p className="mt-4 border-t border-line pt-3 text-xs text-ink-dim">
            After the invoice is created you get an order key — the way back to the order. A wallet
            signature from the paying address also opens it. No account is created.
          </p>
        </div>
      </aside>
    </div>
  );
}
