/**
 * Vitest setup (runs before every test file).
 *
 * - Points Prisma at TEST_DATABASE_URL when one is configured so tests never
 *   touch the development database.
 * - Supplies the secrets lib/env.ts requires so the env schema validates even
 *   in a bare environment; values only matter for consistency within a run.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
process.env.AUTH_SECRET ??= "vitest-auth-secret-not-for-production";
process.env.EMBED_SIGNING_SECRET ??= "vitest-embed-secret-not-for-production";
process.env.AI_DEFAULT_PROVIDER ??= "echo";
process.env.APP_URL ??= "http://localhost:3000";
