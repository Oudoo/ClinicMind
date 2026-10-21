import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Make every variable from .env / .env.test available on process.env so the
    // database-backed route tests find DATABASE_URL (or TEST_DATABASE_URL)
    // locally the same way they do in CI.
    env: loadEnv(mode, process.cwd(), ""),
    setupFiles: ["./src/test/setup.ts"],
    // Route tests share one Postgres database; run files sequentially so their
    // in-memory rate-limit buckets and tenants do not interfere.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
}));
