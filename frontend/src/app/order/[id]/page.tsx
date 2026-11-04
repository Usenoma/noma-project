import { Suspense } from "react";
import type { Metadata } from "next";
import { OrderView } from "@/components/OrderView";

export const metadata: Metadata = { title: "Order" };

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<p className="font-mono text-sm text-ink-dim">loading order…</p>}>
      <OrderView orderId={id} />
    </Suspense>
  );
}
