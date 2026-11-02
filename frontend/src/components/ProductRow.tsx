import Link from "next/link";
import { categoryLabel, specLine, usd } from "@/lib/format";
import type { Product } from "@/lib/types";

export function ProductRow({ product }: { product: Product }) {
  const specs = specLine(product.category, product.specs);
  return (
    <Link
      href={`/p/${product.id}`}
      className="group flex min-h-16 flex-wrap items-center gap-x-5 gap-y-1 px-4 py-3.5 transition-colors hover:bg-bg-raised"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.95rem] text-ink transition-transform duration-300 group-hover:translate-x-0.5">
          {product.title}
        </span>
        <span className="mt-0.5 block font-mono text-[0.7rem] text-ink-dim">
          {categoryLabel(product.category)}
          {product.region ? ` · ${product.region}` : ""}
          {specs ? ` · ${specs}` : ""}
        </span>
      </span>
      <span className="flex items-center gap-3">
        {!product.available ? (
          <span className="font-mono text-[0.6rem] tracking-[0.14em] text-ink-dim uppercase">
            out of stock
          </span>
        ) : null}
        <span className={`tnum font-mono text-sm ${product.available ? "text-ink" : "text-ink-dim"}`}>
          {usd(product.price_usd)}
        </span>
        <span
          className="font-mono text-sm text-ink-dim transition-all duration-300 group-hover:translate-x-1 group-hover:text-accent"
          aria-hidden
        >
          →
        </span>
      </span>
    </Link>
  );
}
