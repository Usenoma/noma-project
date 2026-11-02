// Formatting helpers. Money/time always end up in mono + tabular numerals.

export function usd(value: string | number | null | undefined, opts?: { decimals?: number }): string {
  if (value === null || value === undefined) return "—";
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (Number.isNaN(n)) return "—";
  const d = opts?.decimals ?? 2;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

/** Trim a raw token-amount string (e.g. "19.440000") to a sane display. */
export function amount(value: string | null | undefined, maxDecimals = 6): string {
  if (!value) return "—";
  const n = parseFloat(value);
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: maxDecimals });
}

/** Raw integer units (wei / 6-dec USDG) → human amount. */
export function fromRaw(raw: string, decimals: number, maxDecimals = 6): string {
  if (!raw) return "—";
  const n = Number(raw) / 10 ** decimals;
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: maxDecimals });
}

export function truncateMiddle(s: string, head = 6, tail = 4): string {
  if (s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function shortAddress(addr: string): string {
  return truncateMiddle(addr, 6, 4);
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function dateOnly(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "—";
  const diff = Date.now() - d;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "ago" : "from now";
  const mins = Math.floor(abs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ${suffix}`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} h ${suffix}`;
  const days = Math.floor(hours / 24);
  return `${days} d ${suffix}`;
}

/** "4d 6h" / "12:34" style durations from ms remaining. */
export function duration(ms: number): string {
  if (ms <= 0) return "0:00";
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function secondsToDays(seconds: number): string {
  const d = Math.round(seconds / 86400);
  return `${d} day${d === 1 ? "" : "s"}`;
}

const CATEGORY_LABELS: Record<string, string> = {
  esim: "eSIM",
  ai_credits: "AI credits",
  vpn: "VPN",
  proxy: "Proxy",
  vps: "VPS",
  giftcard: "Gift cards",
};

export function categoryLabel(c: string): string {
  return CATEGORY_LABELS[c] ?? c;
}

/** One-line spec summary per category, for product rows/cards. */
export function specLine(category: string, specs: Record<string, unknown>): string {
  const parts: string[] = [];
  if (category === "esim") {
    if (specs.data_gb != null) parts.push(`${specs.data_gb} GB`);
    if (specs.validity_days != null) parts.push(`${specs.validity_days} days`);
  } else if (category === "vps") {
    if (specs.cpu != null) parts.push(`${specs.cpu} vCPU`);
    if (specs.ram_gb != null) parts.push(`${specs.ram_gb} GB RAM`);
    if (specs.disk_gb != null) parts.push(`${specs.disk_gb} GB disk`);
    if (specs.location != null) parts.push(String(specs.location));
  } else if (category === "vpn") {
    if (specs.duration_days != null) parts.push(`${specs.duration_days} days`);
    if (Array.isArray(specs.protocols)) parts.push(specs.protocols.join(" + "));
  } else if (category === "proxy") {
    if (specs.traffic_gb != null) parts.push(`${specs.traffic_gb} GB`);
    if (specs.proxy_type != null) parts.push(String(specs.proxy_type));
  } else if (category === "ai_credits") {
    if (specs.credit_usd != null) parts.push(`$${specs.credit_usd} credit`);
    if (specs.provider != null) parts.push(String(specs.provider));
  } else if (category === "giftcard") {
    if (specs.brand != null) parts.push(String(specs.brand));
    if (specs.face_value != null)
      parts.push(`${specs.face_value} ${specs.face_currency ?? ""}`.trim());
  }
  return parts.join(" · ");
}
