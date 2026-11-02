"use client";

import { categoryLabel } from "@/lib/format";
import { FEATURES } from "@/lib/features";
import type { Product } from "@/lib/types";
import { FigureBox } from "./FigureBox";

/**
 * NOMA Exposure Receipt (post-launch, gated). Shows exactly what leaves the buyer's side before
 * they pay: which fields go to which recipient, and why the order keeps them encrypted.
 */
export function ExposureReceipt({
  product,
  values,
}: {
  product: Product;
  values?: Record<string, string>;
}) {
  if (!FEATURES.exposureReceipt) return null;

  const fields = product.required_fields ?? [];

  return (
    <FigureBox caption="fig. — what this order shares">
      <div className="flex flex-col gap-2 font-mono text-sm">
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-ink-dim">recipient</span>
          <span className="text-right">the {categoryLabel(product.category)} supplier</span>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-ink-dim">purpose</span>
          <span className="text-right">deliver this order only</span>
        </div>
        {fields.length === 0 ? (
          <p className="border-t border-line pt-2 text-ink-dim">
            this order shares no personal data with the supplier.
          </p>
        ) : (
          <div className="border-t border-line pt-2">
            <div className="mb-1 text-[0.7rem] tracking-widest text-ink-dim uppercase">
              you provide
            </div>
            {fields.map((f) => (
              <div key={f.name} className="flex items-baseline justify-between gap-4 py-0.5">
                <span className="text-ink-dim">
                  {f.label}
                  {f.optional ? " · optional" : ""}
                </span>
                <span className="text-right">
                  {values?.[f.name]?.trim() ? values[f.name] : "—"}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="border-t border-line pt-2 text-xs text-ink-dim">
          NOMA stores the order encrypted; the order key is the only credential. Nothing else is
          shared with anyone.
        </p>
      </div>
    </FigureBox>
  );
}
