import "dotenv/config";

/**
 * Central typed environment configuration. Every external dependency is
 * configured here; secrets are provided at deploy time via .env.
 */
function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const env = {
  nodeEnv: optional("NODE_ENV", "development"),
  appUrl: optional("APP_URL", "http://localhost:3000"),

  databaseUrl: required(
    "DATABASE_URL",
    "postgres://growengine:growengine_dev@localhost:5432/growengine"
  ),
  redisUrl: required("REDIS_URL", "redis://localhost:6379"),

  authSecret: required("AUTH_SECRET", "dev-only-secret-change-in-production"),
  /** 32-byte hex key for AES-256-GCM credential encryption at rest */
  credentialEncryptionKey: required(
    "CREDENTIAL_ENCRYPTION_KEY",
    "0000000000000000000000000000000000000000000000000000000000000000"
  ),

  // AI providers
  anthropicApiKey: optional("ANTHROPIC_API_KEY"),
  openaiApiKey: optional("OPENAI_API_KEY"),
  /** anthropic | openai */
  aiPrimaryProvider: optional("AI_PRIMARY_PROVIDER", "anthropic"),
  anthropicModel: optional("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
  openaiModel: optional("OPENAI_MODEL", "gpt-4o"),
  embeddingModel: optional("EMBEDDING_MODEL", "text-embedding-3-small"),

  // Transcription
  /** Path to a whisper.cpp `main`/`whisper-cli` binary for local transcription */
  whisperCppPath: optional("WHISPER_CPP_PATH"),
  whisperCppModelPath: optional("WHISPER_CPP_MODEL_PATH"),

  // Object storage (MinIO / Hostinger Object Storage — S3 compatible)
  storageEndpoint: optional("STORAGE_ENDPOINT", "localhost"),
  storagePort: Number(optional("STORAGE_PORT", "9000")),
  storageUseSsl: optional("STORAGE_USE_SSL", "false") === "true",
  storageAccessKey: optional("STORAGE_ACCESS_KEY"),
  storageSecretKey: optional("STORAGE_SECRET_KEY"),
  storageBucket: optional("STORAGE_BUCKET", "growengine"),

  // Email
  smtpHost: optional("SMTP_HOST"),
  smtpPort: Number(optional("SMTP_PORT", "587")),
  smtpUser: optional("SMTP_USER"),
  smtpPassword: optional("SMTP_PASSWORD"),
  smtpFrom: optional("SMTP_FROM", "The Grow Engine <no-reply@growengine.app>"),

  // Monitoring
  glitchtipDsn: optional("GLITCHTIP_DSN"),
  otelExporterEndpoint: optional("OTEL_EXPORTER_OTLP_ENDPOINT"),

  // Integration OAuth apps (filled at deploy time)
  metaAppId: optional("META_APP_ID"),
  metaAppSecret: optional("META_APP_SECRET"),
  googleClientId: optional("GOOGLE_CLIENT_ID"),
  googleClientSecret: optional("GOOGLE_CLIENT_SECRET"),
  /** GA4 service account JSON (base64-encoded) for server-to-server access */
  ga4ServiceAccountJson: optional("GA4_SERVICE_ACCOUNT_JSON"),
  googleAdsDeveloperToken: optional("GOOGLE_ADS_DEVELOPER_TOKEN"),
  tiktokAppId: optional("TIKTOK_APP_ID"),
  tiktokAppSecret: optional("TIKTOK_APP_SECRET"),
  linkedinClientId: optional("LINKEDIN_CLIENT_ID"),
  linkedinClientSecret: optional("LINKEDIN_CLIENT_SECRET"),
  xApiKey: optional("X_API_KEY"),
  xApiSecret: optional("X_API_SECRET"),

  // Slack / Teams notification webhooks (tenant-level defaults)
  slackWebhookUrl: optional("SLACK_WEBHOOK_URL"),
  teamsWebhookUrl: optional("TEAMS_WEBHOOK_URL"),

  // Research worker fallback (Playwright/Cheerio/RSS are primary; this is optional)
  scraperApiKey: optional("SCRAPERAPI_KEY"),

  // Wiki.js knowledge base link (self-hosted)
  wikiJsUrl: optional("WIKIJS_URL"),
} as const;

export const isProduction = env.nodeEnv === "production";
