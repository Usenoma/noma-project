"use client";

import { useEffect, useState } from "react";
import {
  ghostBudgetSet,
  ghostProfileCreate,
  ghostProfileDelete,
  ghostProfileUpdate,
  ghostRulesSet,
  ghostVaultGet,
} from "@/lib/api";
import { usd } from "@/lib/format";
import type { GhostField, GhostProfile, GhostRules } from "@/lib/types";

const FIELDS: { field: GhostField; label: string }[] = [
  { field: "email", label: "email" },
  { field: "name", label: "name" },
  { field: "phone", label: "phone" },
  { field: "address", label: "address" },
  { field: "wallet", label: "wallet" },
];

const ALIAS_LABELS: Record<string, string> = {
  name: "name",
  phone: "phone",
  address: "address",
};

export function GhostVault({ vaultKey }: { vaultKey: string }) {
  const [profiles, setProfiles] = useState<GhostProfile[]>([]);
  const [rules, setRules] = useState<GhostRules | null>(null);
  const [keyLast4, setKeyLast4] = useState<string>("");
  const [budget, setBudget] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [budgetInput, setBudgetInput] = useState("");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      const vault = await ghostVaultGet(vaultKey);
      setProfiles(vault.profiles);
      setRules(vault.rules);
      setKeyLast4(vault.key_last4);
      setBudget(vault.budget_usd);
      setRemaining(vault.remaining_usd);
      setBudgetInput(vault.budget_usd ? String(vault.budget_usd) : "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "vault unavailable");
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultKey]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError(null);
    try {
      await ghostProfileCreate(vaultKey, n);
      setName("");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not create profile");
    } finally {
      setBusy(false);
    }
  }

  async function rename(id: string) {
    const n = editName.trim();
    if (!n || busy) return;
    setBusy(true);
    setError(null);
    try {
      await ghostProfileUpdate(vaultKey, id, n);
      setEditing(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not rename profile");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await ghostProfileDelete(vaultKey, id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not delete profile");
    } finally {
      setBusy(false);
    }
  }

  async function setRule(field: GhostField, mode: "alias" | "deny") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await ghostRulesSet(vaultKey, { [field]: mode } as Partial<GhostRules>);
      setRules(res.rules);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not update rules");
    } finally {
      setBusy(false);
    }
  }

  async function saveBudget(e: React.FormEvent) {
    e.preventDefault();
    const value = Number(budgetInput);
    if (busy || Number.isNaN(value) || value < 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await ghostBudgetSet(vaultKey, value);
      setBudget(res.budget_usd);
      setRemaining(res.remaining_usd);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not update the budget");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-lg font-medium tracking-tight">ghost identity & privacy rules</h2>
        <span className="tnum font-mono text-xs text-ink-dim">vault ····{keyLast4}</span>
      </div>

      {error ? <p className="font-mono text-sm text-warn">{error}</p> : null}

      <section className="flex flex-col gap-3">
        <h3 className="field-label">identity profiles</h3>
        {profiles.length === 0 ? (
          <p className="font-mono text-xs text-ink-dim">no profiles</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {profiles.map((p) => (
              <li key={p.id} className="border border-line bg-bg-raised p-3">
                {editing === p.id ? (
                  <form onSubmit={(e) => { e.preventDefault(); void rename(p.id); }} className="flex gap-2">
                    <input value={editName} onChange={(e) => setEditName(e.target.value)} className="field min-w-0 flex-1" maxLength={100} />
                    <button type="submit" disabled={busy || !editName.trim()} className="btn btn-sm">save</button>
                    <button type="button" onClick={() => setEditing(null)} className="btn btn-sm">cancel</button>
                  </form>
                ) : (
                  <>
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="text-sm text-ink">{p.name}</div>
                      <div className="flex gap-2 font-mono text-xs">
                        <button type="button" onClick={() => { setEditing(p.id); setEditName(p.name); }} className="text-accent hover:underline">
                          rename
                        </button>
                        <button type="button" onClick={() => void remove(p.id)} className="text-warn hover:underline">
                          delete
                        </button>
                      </div>
                    </div>
                    <dl className="mt-2 flex flex-col gap-1 font-mono text-xs text-ink-dim">
                      <div>
                        <span className="text-ink">email alias:</span> {p.email_alias}
                      </div>
                      {Object.entries(p.aliases).map(([f, v]) => (
                        <div key={f}>
                          <span className="text-ink">{ALIAS_LABELS[f] ?? f} alias:</span> {v}
                        </div>
                      ))}
                    </dl>
                    <p className="mt-2 font-mono text-[0.62rem] text-ink-dim">
                      aliases are synthetic placeholders for forms that do not verify; real values are never stored
                    </p>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={create} className="flex gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="new profile name (e.g. Forum lurker)…"
            maxLength={100}
            className="field min-w-0 flex-1"
          />
          <button type="submit" disabled={busy || !name.trim()} className="btn btn-sm">
            add profile
          </button>
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="field-label">privacy router — what the agent may share</h3>
        {rules ? (
          <ul className="flex flex-col gap-2">
            {FIELDS.map(({ field, label }) => (
              <li key={field} className="flex flex-wrap items-center justify-between gap-2 border border-line bg-bg-raised p-3">
                <span className="font-mono text-sm text-ink">{label}</span>
                <div className="flex gap-2">
                  {(["alias", "deny"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => void setRule(field, mode)}
                      disabled={busy || (field === "wallet" && mode === "alias")}
                      className={`inline-flex min-h-11 items-center border px-3 font-mono text-xs uppercase transition-colors ${
                        rules[field] === mode ? "border-accent text-accent" : "border-line text-ink-dim hover:border-accent"
                      } disabled:opacity-40`}
                      title={field === "wallet" && mode === "alias" ? "wallet aliases are not offered" : undefined}
                    >
                      {mode === "alias" ? "alias only" : "never share"}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="font-mono text-xs text-ink-dim">loading rules…</p>
        )}
        <p className="font-mono text-xs text-ink-dim">
          “alias only” lets the agent use the profile&apos;s synthetic alias without asking. “never
          share” makes the agent ask for your explicit approval before using the field — you can
          still deny, approve once, or fall back to an alias.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="field-label">ghost payment — agent spending limit</h3>
        <div className="flex flex-wrap items-baseline justify-between gap-2 border border-line bg-bg-raised p-3 font-mono text-xs">
          <span className="text-ink-dim">
            budget <span className="text-ink">{usd(budget)}</span>
          </span>
          <span className="text-ink-dim">
            remaining <span className="text-accent">{usd(remaining)}</span>
          </span>
        </div>
        <form onSubmit={saveBudget} className="flex gap-2">
          <input
            type="number"
            min="0"
            step="0.01"
            value={budgetInput}
            onChange={(e) => setBudgetInput(e.target.value)}
            placeholder="max USD the agent may spend"
            className="field min-w-0 flex-1"
          />
          <button type="submit" disabled={busy || budgetInput.trim() === ""} className="btn btn-sm">
            set budget
          </button>
        </form>
        <p className="font-mono text-xs text-ink-dim">
          the agent can create NOMA orders up to this budget — only when you explicitly ask it to
          buy. it never holds a key or pays: you settle each invoice from your own wallet. $0 turns
          agent purchases off.
        </p>
      </section>
    </div>
  );
}
