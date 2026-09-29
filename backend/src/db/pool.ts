import pg from "pg";
import { config } from "../config.js";

// NUMERIC(78,0) raw token amounts come back as strings; convert with BigInt() at use.
export const db = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });

export type Queryable = pg.Pool | pg.PoolClient;

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const { rows } = await db.query<{ value: T }>("SELECT value FROM settings WHERE key = $1", [key]);
  return rows[0]?.value;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export async function getCursor(name: string): Promise<bigint | undefined> {
  const { rows } = await db.query<{ block: string }>("SELECT block FROM indexer_cursors WHERE name = $1", [name]);
  return rows[0] ? BigInt(rows[0].block) : undefined;
}

/** Pass the transaction client so the cursor commits (or rolls back) with the indexed rows. */
export async function setCursor(name: string, block: bigint, q: Queryable = db): Promise<void> {
  await q.query(
    `INSERT INTO indexer_cursors (name, block) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET block = EXCLUDED.block, updated_at = now()`,
    [name, block.toString()],
  );
}
