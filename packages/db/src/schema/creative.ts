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
  date,
} from "drizzle-orm/pg-core";
import { tenants, users } from "./tenancy.js";
import { clients, projects } from "./clients.js";

export const creativeAssetStatusEnum = pgEnum("creative_asset_status", [
  "draft",
  "internal_review",
  "awaiting_client_approval",
  "approved",
  "rejected",
  "in_pilot",
  "scaled",
  "retired",
]);

export const creativeAssets = pgTable(
  "creative_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    /** image | video | carousel | copy | landing_page */
    assetType: text("asset_type").notNull(),
    status: creativeAssetStatusEnum("status").notNull().default("draft"),
    /** Object storage key for the asset binary */
    storageKey: text("storage_key"),
    previewUrl: text("preview_url"),
    copyText: text("copy_text"),
    /** Target platform(s): meta, tiktok, linkedin... */
    platforms: jsonb("platforms").notNull().default([]),
    metadata: jsonb("metadata").notNull().default({}),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("creative_assets_client_idx").on(t.clientId, t.status)]
);

export const catApprovalStatusEnum = pgEnum("cat_approval_status", [
  "pending",
  "approved",
  "rejected",
  "changes_requested",
]);

/**
 * Creative Acceptance Testing (CAT) — strict client sign-off workflow.
 * Each row is one approval request presented in the client portal.
 */
export const catApprovals = pgTable(
  "cat_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    creativeAssetId: uuid("creative_asset_id")
      .notNull()
      .references(() => creativeAssets.id, { onDelete: "cascade" }),
    status: catApprovalStatusEnum("status").notNull().default("pending"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    /** Client-side signer (portal user) */
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedByName: text("decided_by_name"),
    decisionNote: text("decision_note"),
    /** Sign-off checklist the client confirms: brand, claims, compliance */
    checklist: jsonb("checklist").notNull().default([]),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [index("cat_approvals_client_idx").on(t.clientId, t.status)]
);

export const abPilotStatusEnum = pgEnum("ab_pilot_status", [
  "scheduled",
  "running",
  "completed",
  "promoted",
  "stopped",
]);

/**
 * 7-day micro-budget pilot tests run after CAT approval, before scaling.
 */
export const abPilots = pgTable(
  "ab_pilots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    creativeAssetId: uuid("creative_asset_id")
      .notNull()
      .references(() => creativeAssets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: abPilotStatusEnum("status").notNull().default("scheduled"),
    platform: text("platform").notNull(),
    /** Provider-side campaign/adset ids for live result tracking */
    externalCampaignId: text("external_campaign_id"),
    dailyBudget: numeric("daily_budget", { precision: 12, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("USD"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    /** Daily tracked results with source request ids */
    results: jsonb("results").notNull().default([]),
    /** Final verdict: {winner, upliftPct, significance, recommendation} */
    verdict: jsonb("verdict").notNull().default({}),
    confidenceScore: numeric("confidence_score", { precision: 5, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ab_pilots_client_idx").on(t.clientId, t.status)]
);
