import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  numeric,
  integer,
  boolean,
  pgEnum,
  index,
  uniqueIndex,
  date,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenancy.js";
import { clients } from "./clients.js";

export const integrationProviderEnum = pgEnum("integration_provider", [
  "meta",
  "ga4",
  "google_ads",
  "tiktok",
  "linkedin",
  "x",
  "zoho_crm",
  "hubspot",
  "salesforce",
  "dynamics",
  "odoo",
]);

export const integrationStatusEnum = pgEnum("integration_status", [
  "connected",
  "syncing",
  "error",
  "token_expired",
  "disconnected",
]);

export const syncLogStatusEnum = pgEnum("sync_log_status", [
  "started",
  "success",
  "partial",
  "failed",
]);

/**
 * A connected external data source for a client. Credentials are encrypted
 * at rest (AES-256-GCM via packages/core crypto) — never stored in plaintext.
 */
export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    provider: integrationProviderEnum("provider").notNull(),
    /** Human label, e.g. "Acme — Meta Ads (Main Account)" */
    name: text("name").notNull(),
    /** Provider-side account/property identifiers (ad account id, GA4 property id...) */
    externalAccountId: text("external_account_id"),
    /** AES-256-GCM encrypted JSON blob: tokens, refresh tokens, client secrets */
    encryptedCredentials: text("encrypted_credentials"),
    status: integrationStatusEnum("status").notNull().default("disconnected"),
    /** OAuth token expiry for the Integration Health Center */
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastSuccessfulSyncAt: timestamp("last_successful_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    syncFrequencyMinutes: integer("sync_frequency_minutes").notNull().default(360),
    config: jsonb("config").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("integrations_tenant_idx").on(t.tenantId),
    index("integrations_client_idx").on(t.clientId),
    index("integrations_status_idx").on(t.status),
  ]
);

export const integrationLogs = pgTable(
  "integration_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    status: syncLogStatusEnum("status").notNull(),
    operation: text("operation").notNull(),
    /** Provider request IDs captured for the Verifiable Data Layer */
    apiRequestIds: jsonb("api_request_ids").notNull().default([]),
    recordsFetched: integer("records_fetched").notNull().default(0),
    recordsStored: integer("records_stored").notNull().default(0),
    /** Sanity Check Engine findings for this sync run */
    sanityFindings: jsonb("sanity_findings").notNull().default([]),
    error: text("error"),
    durationMs: integer("duration_ms"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("integration_logs_tenant_idx").on(t.tenantId),
    index("integration_logs_integration_idx").on(t.integrationId, t.startedAt),
  ]
);

/**
 * Normalized daily metric facts pulled from providers. This is the
 * Verifiable Data Layer: every row carries its provider request id and a
 * reference link so any number on a dashboard can be traced to its source.
 */
export const metricRecords = pgTable(
  "metric_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    provider: integrationProviderEnum("provider").notNull(),
    /** Metric key: spend, impressions, clicks, conversions, revenue, sessions... */
    metric: text("metric").notNull(),
    /** Dimension scope, e.g. {"campaign_id": "...", "channel": "paid_social"} */
    dimensions: jsonb("dimensions").notNull().default({}),
    date: date("date").notNull(),
    value: numeric("value", { precision: 18, scale: 4 }).notNull(),
    currency: text("currency"),
    /** Verifiable Data Layer: provider API request id (x-fb-trace-id etc.) */
    sourceRequestId: text("source_request_id"),
    /** Direct deep link back to the provider UI / API resource */
    sourceReferenceUrl: text("source_reference_url"),
    /** Sanity Check Engine verdict */
    sanityStatus: text("sanity_status").notNull().default("passed"),
    sanityNotes: jsonb("sanity_notes").notNull().default([]),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("metric_records_unique_fact_idx").on(
      t.integrationId,
      t.metric,
      t.date,
      t.dimensions
    ),
    index("metric_records_tenant_client_idx").on(t.tenantId, t.clientId, t.date),
    index("metric_records_metric_idx").on(t.clientId, t.metric, t.date),
  ]
);

/**
 * Redis-backed caching is the hot path; this table is the durable cache for
 * computed analytics aggregates (dashboards, digests, QBRs).
 */
export const analyticsCache = pgTable(
  "analytics_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
    cacheKey: text("cache_key").notNull(),
    payload: jsonb("payload").notNull(),
    /** Trace metadata: which metric_records / request ids fed this aggregate */
    sourceTrace: jsonb("source_trace").notNull().default({}),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("analytics_cache_key_idx").on(t.tenantId, t.cacheKey),
  ]
);

/**
 * API Rate Limit Manager bookkeeping — rolling quota usage per provider.
 */
export const apiQuotaUsage = pgTable(
  "api_quota_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    provider: integrationProviderEnum("provider").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    requestCount: integer("request_count").notNull().default(0),
    throttledCount: integer("throttled_count").notNull().default(0),
    quotaLimit: integer("quota_limit"),
    backoffUntil: timestamp("backoff_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("api_quota_window_idx").on(t.tenantId, t.provider, t.windowStart),
  ]
);

/** Whether each provider sync is enabled tenant-wide (kill-switch). */
export const integrationKillSwitches = pgTable(
  "integration_kill_switches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    provider: integrationProviderEnum("provider").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    reason: text("reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("kill_switch_idx").on(t.tenantId, t.provider)]
);
