import { Suspense } from "react";
import type { Metadata } from "next";
import { CheckoutFlow } from "@/components/CheckoutFlow";
import { WalletScope } from "@/components/WalletScope";

export const metadata: Metadata = { title: "Checkout" };

export default function CheckoutPage() {
  return (
    <Suspense fallback={<p className="font-mono text-sm text-ink-dim">loading checkout…</p>}>
      <WalletScope>
        <CheckoutFlow />
      </WalletScope>
    </Suspense>
  );
}
