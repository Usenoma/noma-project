"use client";

import useSWR from "swr";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getProduct } from "@/lib/api";
import { categoryLabel, specLine, usd } from "@/lib/format";
import { EmptyState } from "./EmptyState";

const DELIVERABLE_LINES: Record<string, string> = {
  esim: "an eSIM activation string (LPA) with a QR code",
  ai_credits: "a NOMA API key (OpenAI-compatible) with a prepaid usage balance",
  vpn: "an account plus WireGuard and OpenVPN config files",
  proxy: "gateway credentials with usage examples",
  vps: "server credentials (IP, root password, ssh one-liner)",
  giftcard: "a gift card code",
};

export function ProductView({ id }: { id: string }) {
  const router = useRouter();
  const { data: product, error } = useSWR(["product", id], () => getProduct(id));

  if (error) {
    return <EmptyState line="product unavailable" action={{ href: "/market", label: "back to market" }} />;
  }
  if (!product) {
    return <p className="font-mono text-sm text-ink-dim">loading product…</p>;
  }

  const specs = specLine(product.category, product.specs);

  return (
    <div className="grid gap-12 lg:grid-cols-[1fr_340px]">
      <div className="max-w-2xl">
        <div className="font-mono text-[0.68rem] tracking-[0.16em] text-ink-dim uppercase">
          {categoryLabel(product.category)}
          {product.region ? ` · ${product.region}` : ""}
        </div>
        <h1 className="mt-4 text-4xl tracking-[-0.045em] sm:text-5xl xl:text-6xl">{product.title}</h1>
        {specs ? <p className="tnum mt-3 font-mono text-sm text-ink-dim">{specs}</p> : null}

        <div className="mt-10 border-t border-line-strong pt-4">
          <div className="font-mono text-[0.68rem] tracking-[0.16em] text-ink-dim uppercase">
            what you need to provide
          </div>
          <div className="mt-3">
            {product.required_fields.length === 0 ? (
              <p className="text-sm text-ink-dim">nothing — pay and receive</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {product.required_fields.map((field) => (
                  <li key={field.name} className="flex items-baseline justify-between gap-4">
                    <span className="text-sm">{field.label}</span>
                    <span className="font-mono text-xs text-ink-dim">
                      {field.type}
                      {field.optional ? " · optional" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="mt-8 border-t border-line-strong pt-4">
          <div className="font-mono text-[0.68rem] tracking-[0.16em] text-ink-dim uppercase">
            what you receive
          </div>
          <div className="mt-3">
            <p className="text-sm">{DELIVERABLE_LINES[product.category] ?? "a deliverable"}</p>
            <p className="mt-2 text-sm text-ink-dim">
              Delivery is usually under a minute after payment confirms; the order page shows live
              state.
            </p>
            {product.category === "ai_credits" ? (
              <div className="mt-3 border-t border-line pt-3 text-sm text-ink-dim">
                <p>
                  This is a NOMA API key, not an OpenRouter key. The OpenRouter key stays on our
                  server; your key calls NOMA, and NOMA calls the model. Usage is billed at OpenRouter
                  cost plus the platform fee, and the balance equals the amount you pay.
                </p>
                {Array.isArray(product.specs.models) && product.specs.models.length > 0 ? (
                  <p className="mt-2 font-mono text-xs">
                    models: {(product.specs.models as string[]).join(" · ")}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <aside>
        <div className="panel p-6">
          <div className="font-mono text-[0.62rem] tracking-[0.16em] text-ink-dim uppercase">
            price
          </div>
          <div className="display tnum mt-2 text-5xl tracking-[-0.05em]">
            {usd(product.price_usd)}
          </div>
          <p className="mt-3 font-mono text-xs text-ink-dim">
            locked for 15 min at invoice · pay in USDG or ETH
          </p>
          {product.category === "ai_credits" ? (
            <p className="mt-1 font-mono text-xs text-ink-dim">
              usage balance = the amount paid
            </p>
          ) : null}
          <button
            type="button"
            disabled={!product.available}
            onClick={() => router.push(`/checkout/new?product=${product.id}`)}
            className="btn mt-6 w-full"
          >
            {product.available ? "Buy" : "Out of stock"}
          </button>
          {!product.available ? (
            <p className="mt-3 font-mono text-xs text-ink-dim">
              this supplier cannot cover the order right now — try again later.
            </p>
          ) : null}
          <Link
            href="/market"
            className="mt-4 block text-center font-mono text-xs text-ink-dim transition-colors hover:text-ink"
          >
            ← back to market
          </Link>
        </div>
      </aside>
    </div>
  );
}
