import type { OrderStatus } from "@/lib/types";

// Exact labels per frontend.md §6.1 — the state word is always text, never color alone.
const LABELS: Record<string, string> = {
  created: "created",
  awaiting_payment: "awaiting payment",
  paid: "paid",
  fulfilling: "fulfilling",
  delivered: "delivered",
  expired: "expired",
  failed: "failed",
  refunding: "refunding",
  refunded: "refunded",
  // invoice-level
  pending: "awaiting payment",
  seen: "payment seen",
  confirmed: "confirmed",
  underpaid: "underpaid",
  late_paid: "paid late",
  // cycle-level
  active: "active",
  executing: "executing",
  distributed: "distributed · streaming",
};

const TONES: Record<string, "dim" | "warn" | "accent" | "good" | "bad"> = {
  created: "dim",
  awaiting_payment: "warn",
  paid: "accent",
  fulfilling: "warn",
  delivered: "good",
  expired: "dim",
  failed: "bad",
  refunding: "warn",
  refunded: "bad",
  pending: "warn",
  seen: "warn",
  confirmed: "good",
  underpaid: "warn",
  late_paid: "warn",
  active: "accent",
  executing: "warn",
  distributed: "good",
};

const TONE_CLASS = {
  dim: "text-ink-dim",
  warn: "text-warn",
  accent: "text-accent",
  good: "text-good",
  bad: "text-bad",
} as const;

export function StateWord({
  state,
  suffix,
  size = "base",
}: {
  state: OrderStatus | string;
  suffix?: string;
  size?: "base" | "lg";
}) {
  const label = LABELS[state] ?? state.replaceAll("_", " ");
  const tone = TONES[state] ?? "dim";
  return (
    <span
      className={`font-mono ${size === "lg" ? "text-2xl" : "text-sm"} ${TONE_CLASS[tone]}`}
      data-state={state}
    >
      {label}
      {suffix ? <span className="text-ink-dim"> · {suffix}</span> : null}
    </span>
  );
}
