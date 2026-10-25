import { z } from "zod";

/**
 * Validated, typed environment access.
 *
 * In production the process refuses to start on an invalid configuration or on
 * a known development secret (SEC-5). During `next build` and in development /
 * test, missing values fall back to clearly labelled dev-only defaults so the
 * app can be built and run without a full .env.
 */
const DEV_AUTH_SECRET = "dev-only-auth-secret-not-for-production";
const DEV_EMBED_SECRET = "dev-only-embed-secret-not-for-production";

const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";
const isProduction = process.env.NODE_ENV === "production" && !isBuildPhase;

function blankToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}
const optionalString = () => z.preprocess(blankToUndefined, z.string().optional());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  /** Root domain tenant subdomains are resolved against, e.g. `clinicmind.app`. */
  ROOT_DOMAIN: z.string().default("lvh.me:3000"),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: optionalString(),

  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  EMBED_SIGNING_SECRET: z.string().min(32, "EMBED_SIGNING_SECRET must be at least 32 characters"),

  // ── AI providers ─────────────────────────────────────────────────────────
  /** `auto` picks the first configured provider in the order gemini → openai → anthropic → echo. */
  AI_DEFAULT_PROVIDER: z.enum(["auto", "openai", "anthropic", "gemini", "echo"]).default("auto"),
  /** `auto` picks gemini → openai → echo (Anthropic has no embeddings endpoint). */
  AI_EMBEDDING_PROVIDER: z.enum(["auto", "openai", "gemini", "echo"]).default("auto"),
  OPENAI_API_KEY: optionalString(),
  ANTHROPIC_API_KEY: optionalString(),
  GEMINI_API_KEY: optionalString(),
  OPENAI_MODEL: z.string().default("gpt-4.1-mini"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  GEMINI_EMBEDDING_MODEL: z.string().default("gemini-embedding-001"),
  /** Speech-to-text: `auto` picks the first provider with a key that can transcribe (gemini → openai); `echo` is for tests only. */
  AI_TRANSCRIPTION_PROVIDER: z.enum(["auto", "gemini", "openai", "echo"]).default("auto"),
  GEMINI_TRANSCRIPTION_MODEL: z.string().default("gemini-2.5-flash"),
  OPENAI_TRANSCRIPTION_MODEL: z.string().default("gpt-4o-transcribe"),
  /** Upstream request timeout for every provider call. */
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  /** Encrypts per-tenant provider keys at rest (32+ characters). Derived from AUTH_SECRET when unset. */
  DATA_ENCRYPTION_KEY: optionalString(),

  // ── Outbound e-mail (invitations / password reset) ───────────────────────
  SMTP_URL: z.preprocess(blankToUndefined, z.string().url().optional()),
  MAIL_FROM: optionalString(),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // ── Background jobs (concierge dispatch, alert rules, overdue follow-ups) ─
  /** In-process scheduler (every minute). "off" when an external cron calls POST /api/cron/run instead. */
  SCHEDULER: z.enum(["on", "off"]).default("on"),
  /** Bearer token an external scheduler presents to POST /api/cron/run. Unset = endpoint disabled. */
  CRON_SECRET: optionalString(),
  /** Public base URL for patient-facing links (onboarding, check-ins); defaults to APP_URL. */
  PUBLIC_URL: optionalString(),
});

export type Env = z.infer<typeof schema>;

const parsed = schema.safeParse(process.env);

if (isProduction) {
  if (!parsed.success) {
    const fields = Object.keys(parsed.error.flatten().fieldErrors).join(", ");
    throw new Error(`Invalid environment configuration (${fields}). Refusing to start.`);
  }
  if (
    parsed.data.AUTH_SECRET === DEV_AUTH_SECRET ||
    parsed.data.EMBED_SIGNING_SECRET === DEV_EMBED_SECRET ||
    /dev-insecure|dev-only|not-for-production|change-me|replace-me|vitest/i.test(parsed.data.AUTH_SECRET + parsed.data.EMBED_SIGNING_SECRET)
  ) {
    throw new Error("AUTH_SECRET / EMBED_SIGNING_SECRET are development values. Refusing to start.");
  }
} else if (!parsed.success && process.env.NODE_ENV !== "test" && !isBuildPhase) {
  console.warn(
    "[env] using development defaults for:",
    Object.keys(parsed.error.flatten().fieldErrors).join(", "),
  );
}

export const env: Env = parsed.success
  ? parsed.data
  : schema.parse({
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://clinicmind:clinicmind@localhost:5432/clinicmind?schema=public",
      AUTH_SECRET:
        process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 32 ? process.env.AUTH_SECRET : DEV_AUTH_SECRET,
      EMBED_SIGNING_SECRET:
        process.env.EMBED_SIGNING_SECRET && process.env.EMBED_SIGNING_SECRET.length >= 32
          ? process.env.EMBED_SIGNING_SECRET
          : DEV_EMBED_SECRET,
      APP_URL: process.env.APP_URL && /^https?:\/\//.test(process.env.APP_URL) ? process.env.APP_URL : undefined,
    });

/** True when the process runs with the dev-only fallback secrets. */
export const usingDevSecrets = env.AUTH_SECRET === DEV_AUTH_SECRET || env.EMBED_SIGNING_SECRET === DEV_EMBED_SECRET;
