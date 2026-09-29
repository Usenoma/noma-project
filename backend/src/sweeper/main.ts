import { chainConfigured } from "../chain/client.js";
import { config } from "../config.js";
import { db } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { redis } from "../redis.js";
import { assertSweeperConfig, sweepDeposits } from "./service.js";

/**
 * Deposit sweeper: the only process that holds PAYMENT_XPRV. Runs on its own host / container,
 * moving funds from per-invoice deposit addresses to TREASURY_ADDRESS every SWEEP_INTERVAL_MINUTES.
 * `--once` runs a single pass (for cron or a manual run) and exits.
 */
async function main() {
  if (!chainConfigured) throw new Error("CHAIN_RPC_URL / CHAIN_ID not configured");
  assertSweeperConfig();
  const once = process.argv.includes("--once");
  let stopping = false;
  const shutdown = () => {
    stopping = true;
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  logger.info({ treasury: config.TREASURY_ADDRESS, intervalMinutes: config.SWEEP_INTERVAL_MINUTES, once }, "sweeper started");
  do {
    const swept = await sweepDeposits().catch((err) => {
      logger.error({ err: String(err) }, "sweep pass failed");
      return 0;
    });
    if (swept) logger.info({ swept }, "sweep pass done");
    for (let waited = 0; !once && !stopping && waited < config.SWEEP_INTERVAL_MINUTES * 60; waited++) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  } while (!once && !stopping);

  await db.end();
  redis.disconnect();
}

main().catch((err) => {
  logger.error({ err: String(err) }, "sweeper crashed");
  process.exit(1);
});
