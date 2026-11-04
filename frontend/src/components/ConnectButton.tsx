"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect, type Connector } from "wagmi";
import { shortAddress } from "@/lib/format";

function friendlyError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (/not found|no provider|window\.ethereum|provider not found/i.test(m)) {
    return "no wallet extension found — install MetaMask or Rabby, or use WalletConnect";
  }
  if (/rejected|denied|cancel/i.test(m)) return "connection rejected in the wallet";
  return m.split("\n")[0] || "could not connect";
}

const hasInjectedProvider = () =>
  typeof window !== "undefined" && Boolean((window as Window & { ethereum?: unknown }).ethereum);

function connectorLabel(connector: Connector): string {
  if (connector.id === "walletConnect") return "walletconnect · mobile / qr";
  if (connector.id === "injected") return hasInjectedProvider() ? "browser wallet" : "browser wallet (not found)";
  return connector.name;
}

/** The real wallet button; loads only after the user asks for it (keeps wagmi off light pages). */
export function ConnectButton({ autoConnect = false }: { autoConnect?: boolean }) {
  const { address, isConnected } = useAccount();
  const { connectAsync, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const triedAuto = useRef(false);

  const injectedConnector = connectors.find((c) => c.id === "injected") ?? connectors[0];
  const walletConnectConnector = connectors.find((c) => c.id === "walletConnect");
  const hasChoice = connectors.length > 1;

  /** Desktop extension first; on a phone with no injected wallet prefer WalletConnect. */
  function preferredConnector(): Connector | undefined {
    return hasInjectedProvider() ? injectedConnector : (walletConnectConnector ?? injectedConnector);
  }

  useEffect(() => {
    if (!autoConnect || triedAuto.current || isConnected || isPending) return;
    triedAuto.current = true;
    const injectedC = connectors.find((c) => c.id === "injected") ?? connectors[0];
    const wcC = connectors.find((c) => c.id === "walletConnect");
    const connector = hasInjectedProvider() ? injectedC : (wcC ?? injectedC);
    if (!connector) return;
    connectAsync({ connector }).catch((err) => {
      setError(friendlyError(err));
      if (connectors.length > 1) setChoosing(true);
    });
  }, [autoConnect, isConnected, isPending, connectors, connectAsync]);

  async function connect(connector: Connector) {
    setError(null);
    setChoosing(false);
    try {
      await connectAsync({ connector });
    } catch (err) {
      setError(friendlyError(err));
    }
  }

  function choose() {
    const connector = preferredConnector();
    if (!connector) {
      setError("no wallet available — install MetaMask or Rabby, or use WalletConnect");
      return;
    }
    setChoosing(false);
    void connect(connector);
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
      {choosing && hasChoice ? (
        <span className="flex flex-col items-end gap-1">
          {connectors.map((connector) => (
            <button
              key={connector.uid}
              type="button"
              onClick={() => void connect(connector)}
              disabled={isPending}
              className="inline-flex min-h-11 items-center rounded-full border border-line-strong px-3.5 font-mono text-[0.66rem] tracking-[0.12em] text-ink-dim uppercase transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
            >
              {connectorLabel(connector)}
            </button>
          ))}
        </span>
      ) : (
        <button
          type="button"
          onClick={choose}
          className="inline-flex min-h-11 items-center rounded-full border border-line-strong px-3.5 font-mono text-[0.66rem] tracking-[0.12em] text-ink-dim uppercase transition-colors hover:border-accent hover:text-accent"
        >
          {isPending ? "check wallet…" : "connect wallet"}
        </button>
      )}
      {error ? <span className="max-w-64 text-right font-mono text-[0.62rem] text-warn">{error}</span> : null}
    </span>
  );
}
