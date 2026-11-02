import { Suspense } from "react";
import type { Metadata } from "next";
import { ProductView } from "@/components/ProductView";

export const metadata: Metadata = { title: "Product" };

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<p className="font-mono text-sm text-ink-dim">loading product…</p>}>
      <ProductView id={id} />
    </Suspense>
  );
}
