import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  numeric,
  pgEnum,
  index,
  uniqueIndex,
  date,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenancy.js";
import { clients } from "./clients.js";

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "trialing",
  "active",
  "past_due",
  "cancelled",
]);

export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft",
  "issued",
  "paid",
  "overdue",
  "void",
]);

/**
 * Billing domain — no payment gateway; gateway can be added later behind
 * the same entities (Stripe ids would live in `externalRefs`).
 */
export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    monthlyPrice: numeric("monthly_price", { precision: 12, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("USD"),
    /** Limits: {clients, users, aiTokensPerMonth, integrationsPerClient} */
    limits: jsonb("limits").notNull().default({}),
    features: jsonb("features").notNull().default([]),
    isActive: integer("is_active").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("plans_key_idx").on(t.key)]
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "restrict" }),
    status: subscriptionStatusEnum("status").notNull().default("active"),
    currentPeriodStart: date("current_period_start").notNull(),
    currentPeriodEnd: date("current_period_end").notNull(),
    cancelAtPeriodEnd: integer("cancel_at_period_end").notNull().default(0),
    externalRefs: jsonb("external_refs").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("subscriptions_tenant_idx").on(t.tenantId)]
);

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Optional: agency invoicing its own client */
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "set null",
    }),
    number: text("number").notNull(),
    status: invoiceStatusEnum("status").notNull().default("draft"),
    lineItems: jsonb("line_items").notNull().default([]),
    subtotal: numeric("subtotal", { precision: 14, scale: 2 }).notNull().default("0"),
    tax: numeric("tax", { precision: 14, scale: 2 }).notNull().default("0"),
    total: numeric("total", { precision: 14, scale: 2 }).notNull().default("0"),
    currency: text("currency").notNull().default("USD"),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("invoices_tenant_number_idx").on(t.tenantId, t.number),
    index("invoices_tenant_idx").on(t.tenantId, t.status),
  ]
);

/**
 * Metered usage per tenant: AI tokens, API calls, storage, syncs.
 */
export const usageRecords = pgTable(
  "usage_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** ai_tokens | api_calls | storage_bytes | integration_syncs | transcription_minutes */
    meter: text("meter").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    /** Aggregation day for rollups */
    usageDate: date("usage_date").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("usage_tenant_meter_idx").on(t.tenantId, t.meter, t.usageDate)]
);

/**
 * Cost Tracking — every AI call's token usage and cost, attributable to a
 * tenant, client, project, and feature for the Cost Tracking Dashboard.
 */
export const costTracking = pgTable(
  "cost_tracking",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    projectId: uuid("project_id"),
    /** anthropic | openai | whisper_local | embedding */
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    /** Which platform feature consumed it: dmaic, meeting_analysis, aeo_audit... */
    feature: text("feature").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    aiJobId: uuid("ai_job_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("cost_tracking_tenant_idx").on(t.tenantId, t.createdAt),
    index("cost_tracking_feature_idx").on(t.tenantId, t.feature),
  ]
);
