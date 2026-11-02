import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const blankToUndefined = (v: unknown) => (v === "" ? undefined : v);
const optionalAddress = z.preprocess(blankToUndefined, address.optional());
const optionalString = z.preprocess(blankToUndefined, z.string().optional());
const optionalNumber = z.preprocess(blankToUndefined, z.coerce.number().optional());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  CHAIN_RPC_URL: optionalString,
  CHAIN_ID: optionalNumber,
  PAYMENT_CONFIRMATIONS: z.coerce.number().int().min(1).default(3),

  NOMA_TOKEN_ADDRESS: optionalAddress,
  PONS_V2_FACTORY: optionalAddress,
  PONS_FEE_ESCROW: optionalAddress,
  NOMA_BONDING_CURVE: optionalAddress,
  PONS_V2_MEME_HOOK: optionalAddress,
  NOMA_V4_POOL_ID: optionalString,
  NOMA_QUOTE_ASSET: z.string().default("ETH"),
  STOCK_TOKEN_SOURCE: optionalString,
  ZEC_TOKEN_ADDRESS: optionalAddress,
  REWARD_INDEXER_START_BLOCK: z.preprocess(blankToUndefined, z.coerce.bigint().optional()),

  // Single fixed address buyers pay into (non-custodial: wallet-to-wallet, no deposit-address
  // derivation, no sweeper). Receives both native ETH and ERC-20 USDG.
  PAYMENT_ADDRESS: optionalAddress,
  USDG_ADDRESS: optionalAddress,
  INVOICE_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  OVERPAY_REFUND_MIN_USD: z.coerce.number().min(0).default(0.5),

  // a supplier order still pending after this long is handed to a human (alert); it is never
  // refunded automatically, because the supplier may still deliver
  FULFILLMENT_PENDING_ALERT_MINUTES: z.coerce.number().positive().default(60),

  REFUND_PRIVATE_KEY: optionalString,
  // Automatic refunds for late/underpaid payments and failed fulfillment. When off, the funds are
  // held and an operator can still refund manually via the admin endpoint.
  REFUNDS_AUTO_ENABLED: z.enum(["0", "1"]).default("1").transform((v) => v === "1"),
  // refund hot wallet float: alert below these (ETH also pays the gas of USDG refunds)
  REFUND_WALLET_MIN_ETH: z.coerce.number().min(0).default(0.02),
  REFUND_WALLET_MIN_USDC: z.coerce.number().min(0).default(100),

  // Reward Engine Safe multisig: Pons creator fee recipient + NomaStaking EXECUTOR.
  // The backend only proposes batches (delegate key); owners sign and execute in Safe{Wallet}.
  SAFE_ADDRESS: optionalAddress,
  SAFE_PROPOSER_PRIVATE_KEY: optionalString,
  SAFE_TX_SERVICE_URL: z.string().url().default("https://api.safe.global/tx-service/robinhood"),
  SAFE_API_KEY: optionalString,
  SAFE_MULTISEND_CALL_ONLY: address.default("0x9641d764fc13c8B624c04430C7356C1C7C8102e2"), // Safe v1.4.1 canonical

  // NomaStaking: only staked $NOMA is eligible for rewards. Durations (seconds) mirror the
  // contract's immutables and are only used for display / methodology.
  NOMA_STAKING_ADDRESS: optionalAddress,
  UNSTAKE_COOLDOWN: z.coerce.number().int().positive().default(7 * 24 * 3600),
  REWARD_STREAM_DURATION: z.coerce.number().int().positive().default(7 * 24 * 3600),

  ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, "base64").length === 32, {
    message: "ENCRYPTION_KEY must be 32 bytes, base64-encoded",
  }),
  // Read-only wallet sessions for the buyer vault. Issued after a wallet signature and scoped
  // to order reads; no account and no write access.
  WALLET_SESSION_TTL_MINUTES: z.coerce.number().int().positive().max(1440).default(60),
  ADMIN_TOKEN: z.string().min(24),

  // Alert delivery (all optional; without them alerts are log lines only)
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_CHAT_ID: optionalString,
  ALERT_WEBHOOK_URL: z.preprocess(blankToUndefined, z.string().url().optional()),
  // memecoin-denominated Pons hook fees pending longer than this → alert (Pons operator not sweeping)
  MEMECOIN_FEES_PENDING_ALERT_HOURS: z.coerce.number().positive().default(48),

  LLM_API_KEY: optionalString,
  LLM_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  LLM_MODEL: z.string().default("xiaomi/mimo-v2.6-flash"),

  // AI gateway: buyers get a NOMA key, never an OpenRouter key. OpenRouter is the upstream.
  OPENROUTER_API_KEY: optionalString,
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  OPENROUTER_MODELS: z
    .string()
    .default("openai/gpt-4o-mini")
    .transform((v) => v.split(",").map((m) => m.trim()).filter(Boolean)),
  AI_PUBLIC_BASE_URL: z.string().url().default("http://localhost:3101/api/ai/v1"),
  AI_KEY_TTL_DAYS: z.coerce.number().int().positive().default(365),
  AI_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
  AI_RESERVE_SAFETY: z.coerce.number().min(1).max(3).default(1.15),
  // A reserved usage row older than this is from a crashed/aborted request; the reaper releases it.
  AI_RESERVATION_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(30),

  // Ghost Agent (FEATURE_GHOST_AGENT=1): privacy-first research missions. Search runs through
  // Tavily when a key is set, otherwise keyless DuckDuckGo; page fetches are server-side,
  // stateless and SSRF-guarded.
  TAVILY_API_KEY: optionalString,
  // Ghost missions route through OpenRouter by default (privacy-focused prompts trip the
  // MiMo-direct endpoint's content moderation). Override per deployment if needed.
  GHOST_LLM_API_KEY: optionalString,
  GHOST_LLM_BASE_URL: z.preprocess(blankToUndefined, z.string().url().optional()),
  GHOST_LLM_MODEL: optionalString,
  TAVILY_BASE_URL: z.string().url().default("https://api.tavily.com"),
  GHOST_MAX_SEARCH_RESULTS: z.coerce.number().int().positive().default(5),
  GHOST_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  GHOST_FETCH_MAX_BYTES: z.coerce.number().int().positive().default(200_000),
  GHOST_FETCH_MAX_CHARS: z.coerce.number().int().positive().default(12_000),
  GHOST_MAX_TOOL_TURNS: z.coerce.number().int().positive().default(12),
  // Abuse guards for the free agent chat (each call spends LLM tokens).
  GHOST_DAILY_IP_LIMIT: z.coerce.number().int().positive().default(100),
  GHOST_DAILY_VAULT_MESSAGES: z.coerce.number().int().positive().default(60),

  // Public base URL of this API (e.g. https://api.example.com). Enables supplier webhooks, which
  // only speed up fulfillment; without it suppliers are polled.
  PUBLIC_API_URL: z.preprocess(blankToUndefined, z.string().url().optional()),

  ESIMACCESS_KEY: optionalString,
  BITREFILL_KEY: optionalString,
  BITREFILL_COUNTRIES: z
    .string()
    .default("US,XI")
    .transform((v) => v.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean)),
  BITLAUNCH_KEY: optionalString,
  VPNRESELLERS_KEY: optionalString,
  VPNRESELLERS_MONTHLY_USD: z.coerce.number().positive().default(1.99), // per active account (no price API)
  IPROYAL_KEY: optionalString,
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);
