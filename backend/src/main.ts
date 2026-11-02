import { buildServer } from "./api/server.js";
import { config } from "./config.js";
import { db } from "./db/pool.js";
import { closeQueues } from "./queues.js";
import { redis } from "./redis.js";

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

// On production servers set HOST=127.0.0.1: the frontend reaches the API over localhost
// (Next rewrite), so there is no reason to expose it to the internet without TLS.
app.listen({ port: config.PORT, host: config.HOST }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
