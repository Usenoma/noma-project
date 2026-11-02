import type { Metadata } from "next";
import { RewardsView } from "@/components/RewardsView";
import { WalletScope } from "@/components/WalletScope";

export const metadata: Metadata = { title: "Reward Engine" };

export default function RewardsPage() {
  return (
    <WalletScope>
      <RewardsView />
    </WalletScope>
  );
}
