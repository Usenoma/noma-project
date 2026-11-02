"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { shortAddress } from "@/lib/format";

function friendlyError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (/not found|no provider|window\.ethereum|provider not found/i.test(m)) {
    return "no wallet extension found — install MetaMask or Rabby and reload";
  }
  if (/rejected|denied|cancel/i.test(m)) return "connection rejected in the wallet";
  return m.split("\n")[0] || "could not connect";
}

/** The real wallet button; loads only after the user asks for it (keeps wagmi off light pages). */
export function ConnectButton({ autoConnect = false }: { autoConnect?: boolean }) {
  const { address, isConnected } = useAccount();
  const { connectAsync, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const [error, setError] = useState<string | null>(null);
  const triedAuto = useRef(false);

  useEffect(() => {
    if (!autoConnect || triedAuto.current || isConnected || isPending) return;
    triedAuto.current = true;
    const connector = connectors[0];
    if (!connector) return;
    connectAsync({ connector }).catch((err) => setError(friendlyError(err)));
  }, [autoConnect, isConnected, isPending, connectors, connectAsync]);

  async function connectWallet() {
    setError(null);
    const connector = connectors[0];
    if (!connector) {
      setError("no wallet extension found — install MetaMask or Rabby and reload");
      return;
    }
    try {
      await connectAsync({ connector });
    } catch (err) {
      setError(friendlyError(err));
    }
  }

  if (isConnected && address) {
    return (
      <button
        type="button"
        onClick={() => disconnect()}
        title="disconnect"
        aria-label={`Disconnect ${address}`}
        className="tnum inline-flex min-h-11 items-center gap-2 rounded-full border border-line-strong px-3.5 font-mono text-[0.66rem] tracking-[0.12em] text-ink uppercase transition-colors hover:border-accent hover:text-accent"
      >
        <span className="block h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
        {shortAddress(address)}
      </button>
    );
  }

  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void connectWallet()}
        className="inline-flex min-h-11 items-center rounded-full border border-line-strong px-3.5 font-mono text-[0.66rem] tracking-[0.12em] text-ink-dim uppercase transition-colors hover:border-accent hover:text-accent"
      >
        {isPending ? "check wallet…" : "connect wallet"}
      </button>
      {error ? <span className="max-w-64 text-right font-mono text-[0.62rem] text-warn">{error}</span> : null}
    </span>
  );
}
