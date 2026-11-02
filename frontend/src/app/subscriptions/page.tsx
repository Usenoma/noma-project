"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { useAccount, useSignMessage } from "wagmi";
import { createWalletSession, decideSubscription, getSubscriptions } from "@/lib/api";
import { FEATURES } from "@/lib/features";
import { dateOnly, shortAddress, usd } from "@/lib/format";
import {
  clearWalletSession,
  getWalletSession,
  saveWalletSession,
  walletAuthMessage,
} from "@/lib/walletSession";
import type { WalletSession } from "@/lib/types";
import { EmptyState } from "@/components/EmptyState";
import { WalletButton } from "@/components/WalletButton";
import { WalletScope } from "@/components/WalletScope";

export default function SubscriptionsPage() {
  return (
    <WalletScope>
      <SubscriptionsInner />
    </WalletScope>
  );
}

function SubscriptionsInner() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync, isPending } = useSignMessage();
  const [session, setSession] = useState<WalletSession | null>(null);
  const [checked, setChecked] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);

  useEffect(() => {
    // reading the session after mount is intentional (SSR renders the same shell)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSession(getWalletSession());
     
    setChecked(true);
  }, []);

  useEffect(() => {
    if (session && address && session.address.toLowerCase() !== address.toLowerCase()) {
      clearWalletSession();
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSession(null);
    }
  }, [address, session]);

  const owner = session?.address ?? null;
  const { data, error, mutate } = useSWR(
    FEATURES.subscriptionGuardian && session
      ? ["subscriptions", session.address, session.token.slice(-10)]
      : null,
    () => getSubscriptions(session!.address, session!.token),
  );

  if (!FEATURES.subscriptionGuardian) {
    return <EmptyState line="subscription guardian is not available yet" action={{ href: "/market", label: "browse the market" }} />;
  }

  async function signIn() {
    if (!address || isPending) return;
    setSignError(null);
    try {
      const timestamp = Date.now();
      const signature = await signMessageAsync({ message: walletAuthMessage(address, timestamp) });
      const next = await createWalletSession({ address, signature, timestamp });
      saveWalletSession(next);
      setSession(next);
    } catch (err) {
      setSignError(err instanceof Error ? err.message.split("\n")[0] : "signature rejected");
    }
  }

  function signOut() {
    clearWalletSession();
    setSession(null);
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8">
      <div>
        <div className="rule-label">§01 — subscriptions</div>
        <h1 className="mt-3 text-3xl font-medium tracking-tight sm:text-4xl xl:text-5xl">Subscription Guardian</h1>
        <p className="mt-2 max-w-xl text-sm text-ink-dim">
          Every subscription bought through NOMA: renewal date, price and a recommendation before the
          next charge. The agent proposes; you decide.
        </p>
      </div>

      <div className="border border-line bg-bg-raised p-4">
        {!checked ? (
          <p className="font-mono text-sm text-ink-dim">checking session…</p>
        ) : session ? (
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <div className="font-mono text-[0.65rem] tracking-widest text-accent uppercase">
                read-only session
              </div>
              <div className="tnum mt-1 font-mono text-sm">{shortAddress(session.address)}</div>
              <p className="mt-1 font-mono text-[0.65rem] text-ink-dim">
                subscriptions only · no transaction, no gas
              </p>
            </div>
            <button
              type="button"
              onClick={signOut}
              className="font-mono text-[0.65rem] tracking-widest text-ink-dim uppercase hover:text-ink"
            >
              sign out
            </button>
          </div>
        ) : !isConnected ? (
          <div className="flex flex-col gap-3">
            <p className="font-mono text-sm text-ink-dim">
              connect the wallet that owns the subscriptions.
            </p>
            <WalletButton />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="font-mono text-sm text-ink-dim">
              sign a message to read <span className="text-ink">{shortAddress(address ?? "")}</span>.
              no transaction, no gas.
            </p>
            <button type="button" onClick={signIn} disabled={isPending} className="btn w-full sm:w-auto">
              {isPending ? "confirm in wallet…" : "sign in"}
            </button>
            {signError ? <p className="font-mono text-xs text-bad">{signError}</p> : null}
          </div>
        )}
      </div>

      {!session || !owner ? (
        <p className="font-mono text-sm text-ink-dim">connect and sign in to see the subscriptions.</p>
      ) : error ? (
        <EmptyState line="subscriptions unavailable — sign in again or check the wallet" />
      ) : !data ? (
        <p className="font-mono text-sm text-ink-dim">loading subscriptions…</p>
      ) : data.subscriptions.length === 0 ? (
        <EmptyState line="no subscriptions for this wallet" action={{ href: "/market", label: "browse the market" }} />
      ) : (
        <div className="overflow-x-auto border border-line">
          <table className="w-full font-mono text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[0.7rem] tracking-widest text-ink-dim uppercase">
                <th className="px-4 py-2 font-normal">service</th>
                <th className="px-4 py-2 font-normal">renews</th>
                <th className="px-4 py-2 font-normal">price</th>
                <th className="px-4 py-2 font-normal">status</th>
                <th className="px-4 py-2 font-normal">action</th>
              </tr>
            </thead>
            <tbody>
              {data.subscriptions.map((s) => (
                <tr key={s.id} className="border-b border-line last:border-b-0">
                  <td className="px-4 py-2.5">
                    <div className="text-ink">{s.service}</div>
                    {s.recommendation ? (
                      <div className="text-xs text-warn">{s.recommendation}</div>
                    ) : null}
                    {s.order_id ? (
                      <Link href={`/order/${s.order_id}`} className="text-xs text-accent hover:underline">
                        open order →
                      </Link>
                    ) : null}
                  </td>
                  <td className="tnum px-4 py-2.5 text-ink-dim">{dateOnly(s.renewal_at)}</td>
                  <td className="tnum px-4 py-2.5">{s.price_usd ? usd(s.price_usd) : "—"}</td>
                  <td className="px-4 py-2.5">
                    <span
                      className={
                        s.status === "active"
                          ? "text-good"
                          : s.status === "cancelled"
                            ? "text-bad"
                            : "text-ink-dim"
                      }
                    >
                      {s.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {s.status === "active" ? (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={async () => {
                            await decideSubscription(s.id, "keep", session.token);
                            await mutate();
                          }}
                          className="border border-line px-2 py-1 text-xs tracking-widest uppercase hover:border-accent hover:text-accent"
                        >
                          keep
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            await decideSubscription(s.id, "cancel", session.token);
                            await mutate();
                          }}
                          className="border border-line px-2 py-1 text-xs tracking-widest text-bad uppercase hover:border-bad"
                        >
                          cancel
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-ink-dim">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="font-mono text-xs text-ink-dim">
        the agent never renews or cancels on its own. a recommendation without a reason is not shown.
        subscription reads require the owner&apos;s wallet signature; no address can be queried
        anonymously.
      </p>
    </div>
  );
}
