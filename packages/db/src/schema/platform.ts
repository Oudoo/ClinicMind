import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants, users } from "./tenancy.js";
import { clients } from "./clients.js";

/**
 * Enterprise Audit Trail — immutable record of every significant action.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorType: text("actor_type").notNull().default("user"),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    /** Before/after snapshot for changes */
    changes: jsonb("changes").notNull().default({}),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_logs_tenant_idx").on(t.tenantId, t.createdAt),
    index("audit_logs_entity_idx").on(t.entityType, t.entityId),
  ]
);

export const notificationChannelEnum = pgEnum("notification_channel", [
  "in_app",
  "email",
  "slack",
  "teams",
  "webhook",
]);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    channel: notificationChannelEnum("channel").notNull().default("in_app"),
    /** Template key that produced this notification */
    templateKey: text("template_key"),
    title: text("title").notNull(),
    body: text("body"),
    linkUrl: text("link_url"),
    /** queued | sent | delivered | failed | read */
    status: text("status").notNull().default("queued"),
    error: text("error"),
    metadata: jsonb("metadata").notNull().default({}),
    readAt: timestamp("read_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId, t.status),
    index("notifications_tenant_idx").on(t.tenantId, t.createdAt),
  ]
);

export const notificationTemplates = pgTable(
  "notification_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    /** Handlebars-style {{placeholders}} */
    subjectTemplate: text("subject_template").notNull(),
    bodyTemplate: text("body_template").notNull(),
    channels: jsonb("channels").notNull().default(["in_app"]),
    isActive: integer("is_active").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("notif_templates_tenant_key_idx").on(t.tenantId, t.key)]
);

/**
 * Notification Rules — which domain events notify whom on which channels.
 */
export const notificationRules = pgTable(
  "notification_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Domain event type this rule listens to, e.g. "integration.failed" */
    eventType: text("event_type").notNull(),
    templateKey: text("template_key").notNull(),
    channels: jsonb("channels").notNull().default(["in_app"]),
    /** Audience: {roles: [], userIds: [], clientPortal: bool} */
    audience: jsonb("audience").notNull().default({}),
    conditions: jsonb("conditions").notNull().default({}),
    isActive: integer("is_active").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notif_rules_event_idx").on(t.tenantId, t.eventType)]
);

export const featureRequests = pgTable(
  "feature_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    /** open | planned | in_progress | shipped | declined */
    status: text("status").notNull().default("open"),
    submittedBy: uuid("submitted_by").references(() => users.id, { onDelete: "set null" }),
    voteCount: integer("vote_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("feature_requests_tenant_idx").on(t.tenantId, t.status)]
);

export const votes = pgTable(
  "votes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    featureRequestId: uuid("feature_request_id")
      .notNull()
      .references(() => featureRequests.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("votes_unique_idx").on(t.featureRequestId, t.userId)]
);

export const aiJobStatusEnum = pgEnum("ai_job_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * AIJobs — every AI worker job, tracked end to end with cost linkage.
 */
export const aiJobs = pgTable(
  "ai_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    /** report | dmaic | aeo_audit | meeting_analysis | sow | recommendation_verify | forecast | embedding | lead_audit | qbr | digest */
    jobType: text("job_type").notNull(),
    status: aiJobStatusEnum("status").notNull().default("queued"),
    input: jsonb("input").notNull().default({}),
    output: jsonb("output").notNull().default({}),
    /** BullMQ job id for cross-referencing queue_jobs */
    queueJobId: text("queue_job_id"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_jobs_tenant_idx").on(t.tenantId, t.status),
    index("ai_jobs_type_idx").on(t.jobType, t.status),
  ]
);

/**
 * QueueJobs — durable mirror of BullMQ job lifecycle for the System
 * Health Dashboard (queue depth, failures, latency).
 */
export const queueJobs = pgTable(
  "queue_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    queueName: text("queue_name").notNull(),
    jobName: text("job_name").notNull(),
    bullJobId: text("bull_job_id").notNull(),
    /** waiting | active | completed | failed | delayed */
    status: text("status").notNull().default("waiting"),
    payloadSummary: jsonb("payload_summary").notNull().default({}),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    durationMs: integer("duration_ms"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("queue_jobs_queue_idx").on(t.queueName, t.status),
    index("queue_jobs_bull_idx").on(t.bullJobId),
  ]
);

/**
 * Domain Event Layer — every published event is persisted here before
 * fan-out, decoupling producers from consumers.
 */
export const domainEvents = pgTable(
  "domain_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    /** e.g. client.created, meeting.analyzed, forecast.generated, integration.failed */
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    /** Entity the event concerns */
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    /** pending | dispatched | failed */
    dispatchStatus: text("dispatch_status").notNull().default("pending"),
    handlerResults: jsonb("handler_results").notNull().default([]),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  },
  (t) => [
    index("domain_events_type_idx").on(t.eventType, t.occurredAt),
    index("domain_events_tenant_idx").on(t.tenantId, t.occurredAt),
  ]
);

/**
 * Outbound webhook endpoints (tenant-configured) + delivery log.
 */
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    /** Event types this endpoint subscribes to; ["*"] = all */
    eventTypes: jsonb("event_types").notNull().default([]),
    /** HMAC signing secret (encrypted) */
    encryptedSecret: text("encrypted_secret"),
    isActive: integer("is_active").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webhook_endpoints_tenant_idx").on(t.tenantId)]
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    responseStatus: integer("response_status"),
    /** pending | delivered | failed */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webhook_deliveries_endpoint_idx").on(t.endpointId, t.status)]
);

/**
 * Disaster recovery bookkeeping — backup runs recorded for the ops portal.
 */
export const backupRecords = pgTable(
  "backup_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** postgres | object_storage | full_snapshot */
    backupType: text("backup_type").notNull(),
    storageKey: text("storage_key"),
    sizeBytes: text("size_bytes"),
    /** running | completed | failed */
    status: text("status").notNull().default("running"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [index("backup_records_type_idx").on(t.backupType, t.startedAt)]
);
