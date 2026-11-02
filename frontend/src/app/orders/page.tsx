import type { Metadata } from "next";
import { BuyerVault } from "@/components/BuyerVault";
import { WalletScope } from "@/components/WalletScope";

export const metadata: Metadata = { title: "Orders" };

export default function OrdersPage() {
  return (
    <WalletScope>
      <BuyerVault />
    </WalletScope>
  );
}
