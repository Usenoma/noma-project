"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { WalletScope } from "./WalletScope";

const ConnectButton = dynamic(() => import("./ConnectButton").then((m) => m.ConnectButton), {
  ssr: false,
  loading: () => (
    <span className="inline-flex min-h-11 items-center rounded-full border border-line-strong px-3.5 font-mono text-[0.66rem] tracking-[0.12em] text-ink-dim uppercase">
      loading wallet…
    </span>
  ),
});

// Quiet ruled wallet control. Optional everywhere — never gates reading.
// Two-stage load: the placeholder needs no wagmi; the wallet stack downloads only after a
// click, then connects immediately (one click total, with visible loading and errors).
export function WalletButton() {
  const [wanted, setWanted] = useState(false);

  if (!wanted) {
    return (
      <button
        type="button"
        onClick={() => setWanted(true)}
        className="inline-flex min-h-11 items-center rounded-full border border-line-strong px-3.5 font-mono text-[0.66rem] tracking-[0.12em] text-ink-dim uppercase transition-colors hover:border-accent hover:text-accent"
      >
        connect wallet
      </button>
    );
  }

  return (
    <WalletScope>
      <ConnectButton autoConnect />
    </WalletScope>
  );
}
