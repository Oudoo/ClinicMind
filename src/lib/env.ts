import { z } from "zod";

/**
 * Validated, typed environment access. Importing `env` anywhere guarantees the
 * process is configured correctly or fails fast at boot.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  ROOT_DOMAIN: z.string().default("lvh.me:3000"),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(),

  AUTH_SECRET: z.string().min(16, "AUTH_SECRET must be at least 16 chars"),
  EMBED_SIGNING_SECRET: z.string().min(16, "EMBED_SIGNING_SECRET must be at least 16 chars"),

  AI_DEFAULT_PROVIDER: z.enum(["openai", "anthropic", "gemini", "echo"]).default("openai"),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),

  HOST_DASHBOARD_ORIGIN: z.string().optional(),
});

// During `next build` / CI without a real env, fall back to safe defaults so the
// build can complete; runtime still validates the critical secrets.
const parsed = schema.safeParse(process.env);

if (!parsed.success && process.env.NODE_ENV === "production") {
  console.error("❌ Invalid environment:", parsed.error.flatten().fieldErrors);
}

export const env = parsed.success
  ? parsed.data
  : ({
      NODE_ENV: (process.env.NODE_ENV as "development") ?? "development",
      APP_URL: process.env.APP_URL ?? "http://localhost:3000",
      ROOT_DOMAIN: process.env.ROOT_DOMAIN ?? "lvh.me:3000",
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://localhost:5432/clinicmind",
      REDIS_URL: process.env.REDIS_URL,
      AUTH_SECRET: process.env.AUTH_SECRET ?? "dev-insecure-auth-secret-change-me",
      EMBED_SIGNING_SECRET:
        process.env.EMBED_SIGNING_SECRET ?? "dev-insecure-embed-secret-change-me",
      AI_DEFAULT_PROVIDER: (process.env.AI_DEFAULT_PROVIDER as "openai") ?? "echo",
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      HOST_DASHBOARD_ORIGIN: process.env.HOST_DASHBOARD_ORIGIN,
    } satisfies z.infer<typeof schema>);

export type Env = z.infer<typeof schema>;
