import { PrismaClient } from "@prisma/client";

/**
 * Let the application's database role sign in. The migrations create
 * `clinicmind_app` without a password (row-level security binds it, see
 * src/lib/db.ts); run this after `prisma migrate deploy`, connected as the
 * owner (DATABASE_URL), to set or rotate its password:
 *
 *   APP_DB_PASSWORD=… npx tsx scripts/db-app-role.ts
 *
 * The app then connects as clinicmind_app (DATABASE_URL) and as the owner for
 * cross-clinic work (SYSTEM_DATABASE_URL). Use a URL-safe password
 * (`openssl rand -hex 32`): it goes into a connection string.
 */
async function main(): Promise<void> {
  const password = process.env.APP_DB_PASSWORD?.trim() ?? "";
  if (password.length < 16 || !/^[A-Za-z0-9._~-]+$/.test(password)) {
    console.error("APP_DB_PASSWORD must be set: 16+ URL-safe characters (openssl rand -hex 32)");
    process.exitCode = 1;
    return;
  }
  const db = new PrismaClient();
  try {
    const [role] = await db.$queryRaw<{ exists: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicmind_app') AS exists`;
    if (!role?.exists) {
      console.error("The role clinicmind_app does not exist: run `npx prisma migrate deploy` first");
      process.exitCode = 1;
      return;
    }
    // Postgres quotes the password itself (format %L), so nothing reaches the statement unescaped.
    const [statement] = await db.$queryRaw<{ sql: string }[]>`SELECT format('ALTER ROLE clinicmind_app WITH LOGIN PASSWORD %L', ${password}) AS sql`;
    await db.$executeRawUnsafe(statement!.sql);
    console.log("✅ clinicmind_app can sign in: point DATABASE_URL at it and SYSTEM_DATABASE_URL at the owner.");
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
