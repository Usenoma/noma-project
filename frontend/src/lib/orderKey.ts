"use client";

// Order keys live in the URL fragment (#k=...) so they never hit server logs.
// This module is the only place that reads/writes the key. The key must never
// be passed to console.log, analytics, or error reporting.

const FRAG_PREFIX = "k=";

export function readOrderKey(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash.startsWith(FRAG_PREFIX)) return null;
  const key = hash.slice(FRAG_PREFIX.length);
  return key.length > 0 ? key : null;
}

export function writeOrderKey(key: string): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.hash = `${FRAG_PREFIX}${key}`;
  window.history.replaceState(null, "", url.toString());
}

export function clearOrderKey(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.hash = "";
  window.history.replaceState(null, "", url.toString());
}

export function orderUrl(orderId: string, orderKey?: string): string {
  return `/order/${orderId}${orderKey ? `#${FRAG_PREFIX}${orderKey}` : ""}`;
}

/** Optional local persistence, only with explicit user opt-in. */
const LS_PREFIX = "noma:order:";

export function rememberOrder(orderId: string, key: string): void {
  try {
    localStorage.setItem(`${LS_PREFIX}${orderId}`, key);
  } catch {
    // storage unavailable — the fragment still works
  }
}

export function recallOrder(orderId: string): string | null {
  try {
    return localStorage.getItem(`${LS_PREFIX}${orderId}`);
  } catch {
    return null;
  }
}

/** Every order key explicitly saved on this device, for the buyer vault. Keys stay local. */
export function listRememberedOrders(): { orderId: string; key: string }[] {
  if (typeof window === "undefined") return [];
  const out: { orderId: string; key: string }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i);
      if (!name?.startsWith(LS_PREFIX)) continue;
      const orderId = name.slice(LS_PREFIX.length);
      const key = localStorage.getItem(name);
      if (orderId && key) out.push({ orderId, key });
    }
  } catch {
    return [];
  }
  return out;
}

export function forgetOrder(orderId: string): void {
  try {
    localStorage.removeItem(`${LS_PREFIX}${orderId}`);
  } catch {
    // ignore
  }
}
