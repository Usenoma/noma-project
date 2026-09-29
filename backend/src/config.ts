import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const blankToUndefined = (v: unknown) => (v === "" ? undefined : v);
const optionalAddress = z.preprocess(blankToUndefined, address.optional());
const optionalString = z.preprocess(blankToUndefined, z.string().optional());
const optionalNumber = z.preprocess(blankToUndefined, z.coerce.number().optional());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
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

  PAYMENT_XPUB: optionalString,
  USDC_ADDRESS: optionalAddress,
  INVOICE_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  OVERPAY_REFUND_MIN_USD: z.coerce.number().min(0).default(0.5),

  REFUND_PRIVATE_KEY: optionalString,

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
  ADMIN_TOKEN: z.string().min(24),

  LLM_API_KEY: optionalString,
  LLM_MODEL: z.string().default("claude-opus-5"),

  ESIMACCESS_KEY: optionalString,
  BITREFILL_KEY: optionalString,
  BITREFILL_COUNTRIES: z
    .string()
    .default("US,XI")
    .transform((v) => v.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean)),
  CRYPTOREFILLS_KEY: optionalString,
  BITLAUNCH_KEY: optionalString,
  VPNRESELLERS_KEY: optionalString,
  IPROYAL_KEY: optionalString,
  OPENROUTER_PROVISIONING_KEY: optionalString,
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);
