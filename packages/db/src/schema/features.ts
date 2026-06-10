import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenancy.js";

/**
 * Feature flag system — platform features that can be toggled per tenant.
 */
export const features = pgTable(
  "features",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** e.g. "dmaic", "aeo_auditor", "process_intelligence" */
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Default state for tenants without an explicit flag. */
    defaultEnabled: boolean("default_enabled").notNull().default(true),
    isBeta: boolean("is_beta").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("features_key_idx").on(t.key)]
);

export const featureFlags = pgTable(
  "feature_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    featureId: uuid("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull(),
    /** Optional rollout config: percentage, client allow-lists, etc. */
    config: jsonb("config").notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("feature_flags_tenant_feature_idx").on(t.tenantId, t.featureId)]
);
