import { config } from "../config.js";
import { redis } from "../redis.js";
import { logger } from "./logger.js";

/**
 * "alert": something is wrong and needs attention. "action": a human must do something now
 * (e.g. Safe owners sign a queued transaction).
 */
export type AlertKind = "alert" | "action";

export interface AlertOptions {
  kind?: AlertKind;
  /** Same key within the cooldown is delivered once; the log line is always written. */
  key?: string;
  cooldownSeconds?: number;
}

const DEFAULT_COOLDOWN = 3600;
const SEND_TIMEOUT_MS = 5_000;

export const alertDeliveryConfigured = () =>
  Boolean((config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) || config.ALERT_WEBHOOK_URL);

const bigintSafe = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

/** Plain-text body shared by every channel. */
export function formatAlert(kind: AlertKind, message: string, details: Record<string, unknown>): string {
  const lines = [`[NOMA ${config.NODE_ENV}] ${kind === "action" ? "ACTION" : "ALERT"}: ${message}`];
  for (const [k, v] of Object.entries(details)) {
    if (v === undefined || v === null) continue;
    lines.push(`${k}: ${typeof v === "object" ? JSON.stringify(v, bigintSafe) : String(v)}`);
  }
  return lines.join("\n");
}

async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body, bigintSafe),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** Claims the delivery slot for `key`; true when this call should send. Fails open without Redis. */
async function claimDelivery(key: string, cooldownSeconds: number): Promise<boolean> {
  try {
    return (await redis.set(`alert:${key}`, "1", "EX", cooldownSeconds, "NX")) === "OK";
  } catch {
    return true;
  }
}

/**
 * Logs an alert and, when configured, delivers it to Telegram and/or a generic JSON webhook.
 * Never throws: a delivery failure is logged and must not break the worker that raised the alert.
 */
export async function alert(message: string, details: Record<string, unknown> = {}, opts: AlertOptions = {}): Promise<void> {
  const kind = opts.kind ?? "alert";
  const prefix = kind === "action" ? "ACTION" : "ALERT";
  if (kind === "action") logger.warn(details, `${prefix} ${message}`);
  else logger.error(details, `${prefix} ${message}`);

  if (!alertDeliveryConfigured()) return;
  if (!(await claimDelivery(opts.key ?? message, opts.cooldownSeconds ?? DEFAULT_COOLDOWN))) return;

  const text = formatAlert(kind, message, details);
  const sends: Promise<void>[] = [];
  if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
    sends.push(
      post(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: config.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    );
  }
  if (config.ALERT_WEBHOOK_URL) {
    sends.push(post(config.ALERT_WEBHOOK_URL, { kind, message, details, text, env: config.NODE_ENV, at: new Date().toISOString() }));
  }
  const results = await Promise.allSettled(sends);
  for (const r of results) {
    if (r.status === "rejected") logger.warn({ err: String(r.reason) }, "alert delivery failed");
  }
}
