"use client";

import type { WalletSession } from "./types";

// Read-only wallet session. The raw signature is exchanged for a short-lived bearer token and
// never stored. sessionStorage keeps it for this tab only; it grants order reads, nothing else.
const STORAGE_KEY = "noma:wallet-session";

/** Must match the backend's walletAuthMessage exactly. */
export function walletAuthMessage(address: string, timestamp: number): string {
  return `NOMA: view my orders\naddress: ${address.toLowerCase()}\ntimestamp: ${timestamp}`;
}

export function getWalletSession(now = Date.now()): WalletSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WalletSession>;
    if (!parsed.token || !parsed.address || !parsed.expires_at) return null;
    if (Date.parse(parsed.expires_at) <= now) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return { token: parsed.token, address: parsed.address, expires_at: parsed.expires_at };
  } catch {
    return null;
  }
}

export function saveWalletSession(session: WalletSession): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // storage unavailable — the in-memory session still works for this page
  }
}

export function clearWalletSession(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
