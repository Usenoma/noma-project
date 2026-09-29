import { buildServer } from "./api/server.js";
import { assertNoSweeperSecrets, config } from "./config.js";
import { db } from "./db/pool.js";
import { closeQueues } from "./queues.js";
import { redis } from "./redis.js";

assertNoSweeperSecrets("api");
const app = buildServer();

const shutdown = async () => {
  await app.close();
  await closeQueues();
  await db.end();
  redis.disconnect();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

app.listen({ port: config.PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
