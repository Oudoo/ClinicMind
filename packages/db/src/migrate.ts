import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import "dotenv/config";

const connectionString =
  process.env.DATABASE_URL ??
  "postgres://growengine:growengine_dev@localhost:5432/growengine";

async function main() {
  const sql = postgres(connectionString, { max: 1 });
  // pgvector must exist before any vector column migration runs
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  const db = drizzle(sql);
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied successfully");
  await sql.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
