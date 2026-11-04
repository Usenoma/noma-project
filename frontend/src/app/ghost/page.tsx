"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { EmptyState } from "@/components/EmptyState";
import { GhostChat } from "@/components/GhostChat";
import { GhostVault } from "@/components/GhostVault";
import { ghostVaultCreate } from "@/lib/api";
import { FEATURES } from "@/lib/features";
import { clearGhostKey, getGhostKey, saveGhostKey } from "@/lib/ghostKey";

export default function GhostPage() {
  const [vaultKey, setVaultKey] = useState<string | null | undefined>(undefined);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [remember, setRemember] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // read localStorage after mount so SSR and hydration render the same shell
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVaultKey(getGhostKey());
  }, []);

  if (!FEATURES.ghostAgent) {
    return <EmptyState line="ghost agent is not available yet" action={{ href: "/market", label: "browse the market" }} />;
  }

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const res = await ghostVaultCreate();
      setFreshKey(res.vault_key);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not create a vault");
    } finally {
      setCreating(false);
    }
  }

  function enter() {
    if (!freshKey) return;
    if (remember) saveGhostKey(freshKey);
    setVaultKey(freshKey);
    setFreshKey(null);
  }

  function forget() {
    clearGhostKey();
    setVaultKey(null);
  }

  if (vaultKey === undefined) {
    return <p className="font-mono text-sm text-ink-dim">loading…</p>;
  }

  // a key was just created: show it exactly once
  if (freshKey) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <div>
          <div className="rule-label">ghost agent</div>
          <h1 className="mt-4 text-4xl tracking-[-0.045em]">Your ghost vault key</h1>
          <p className="mt-3 font-mono text-xs text-warn">
            shown once — save it now. it is the only way back to this vault.
          </p>
        </div>
        <div className="flex flex-col gap-3 border border-line bg-bg-raised p-4">
          <code className="break-all rounded-sm border border-line bg-bg p-3 font-mono text-sm text-accent">
            {freshKey}
          </code>
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(freshKey)}
            className="btn btn-sm self-start"
          >
            copy key
          </button>
        </div>
        <label className="flex items-center gap-2 font-mono text-sm text-ink">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          remember this vault on this device
        </label>
        <div className="flex gap-2">
          <button type="button" onClick={enter} className="btn">
            enter the vault
          </button>
        </div>
        <p className="font-mono text-xs text-ink-dim">
          the key is stored only on your device (opt-in). no account, no email, no recovery — like an
          order key.
        </p>
      </div>
    );
  }

  // no vault on this device
  if (!vaultKey) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <div>
          <div className="rule-label">ghost agent</div>
          <h1 className="mt-4 text-4xl tracking-[-0.045em] sm:text-5xl">Let AI act. Keep yourself private.</h1>
          <p className="mt-3 max-w-xl text-sm text-ink-dim">
            An agent that researches the public web for you — comparing prices and privacy
            requirements — without touching your real data unless you approve it. Every mission ends
            with a ghost receipt: sites visited, actions taken, permissions used, information shared.
          </p>
        </div>

        <div className="grid gap-px border border-line bg-line sm:grid-cols-3">
          {[
            ["zero-trust", "every mission starts with no sensitive permissions; the agent must ask before sharing personal data"],
            ["privacy router", "you set the rules: alias only or never share, per field — enforced on every action"],
            ["ghost receipt", "a report of what happened: pages fetched, permissions used, and exactly what was shared"],
          ].map(([title, body]) => (
            <div key={title} className="bg-bg-raised p-4">
              <h2 className="font-mono text-sm text-accent">{title}</h2>
              <p className="mt-2 text-xs text-ink-dim">{body}</p>
            </div>
          ))}
        </div>

        {error ? <p className="font-mono text-sm text-warn">{error}</p> : null}
        <button type="button" onClick={() => void create()} disabled={creating} className="btn self-start">
          {creating ? "creating…" : "create a ghost vault"}
        </button>
        <p className="font-mono text-xs text-ink-dim">
          research runs through a search API and isolated server-side page fetches — no cookies, no
          browsing history, no connection to anything you do in your own browser.{" "}
          <Link href="/docs" className="text-accent hover:underline">
            see the docs
          </Link>
        </p>
      </div>
    );
  }

  // vault unlocked
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="rule-label">ghost agent</div>
          <h1 className="mt-2 text-2xl font-medium tracking-tight sm:text-3xl">
            Let AI act. Keep yourself private.
          </h1>
        </div>
        <p className="max-w-sm font-mono text-[0.65rem] leading-4 text-ink-dim">
          research runs under your privacy rules; real personal data is only shared with your explicit
          approval and never stored.
        </p>
      </div>

      <GhostChat vaultKey={vaultKey} />

      <GhostVault vaultKey={vaultKey} />

      <div className="flex items-baseline justify-between border-t border-line pt-4">
        <p className="font-mono text-xs text-ink-dim">lose the key, lose the vault — there is no recovery.</p>
        <button type="button" onClick={forget} className="font-mono text-xs text-warn hover:underline">
          forget this device
        </button>
      </div>
    </div>
  );
}
