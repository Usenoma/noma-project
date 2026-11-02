import type { Metadata } from "next";
import { LookupView } from "@/components/LookupView";

export const metadata: Metadata = { title: "Wallet Lookup" };

export default function LookupPage() {
  return <LookupView />;
}
