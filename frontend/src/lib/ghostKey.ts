"use client";

// The ghost vault key is the only credential for the Ghost Agent vault. Like order keys, it is
// never sent to logs or analytics; it lives in localStorage only with explicit opt-in
// ("remember on this device"). Without it the vault is unrecoverable.

const LS_KEY = "noma:ghost-vault";

export function getGhostKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(LS_KEY);
  } catch {
    return null;
  }
}

export function saveGhostKey(key: string): void {
  try {
    localStorage.setItem(LS_KEY, key);
  } catch {
    // storage unavailable — the key stays only in memory
  }
}

export function clearGhostKey(): void {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    // ignore
  }
}
