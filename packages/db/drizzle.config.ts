import { defineConfig } from "drizzle-kit";
import "dotenv/config";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://growengine:growengine_dev@localhost:5432/growengine",
  },
  extensionsFilters: ["postgis"],
  verbose: true,
  strict: true,
});
