import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

declare global {
  // eslint-disable-next-line no-var
  var __growengine_sql: ReturnType<typeof postgres> | undefined;
}

const connectionString =
  process.env.DATABASE_URL ??
  "postgres://growengine:growengine_dev@localhost:5432/growengine";

/**
 * Single shared connection pool. Re-used across hot reloads in dev to avoid
 * exhausting Postgres connections.
 */
const sql =
  globalThis.__growengine_sql ??
  postgres(connectionString, {
    max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    idle_timeout: 30,
    connect_timeout: 10,
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__growengine_sql = sql;
}

export const db = drizzle(sql, { schema });
export { sql };
export type Database = typeof db;
