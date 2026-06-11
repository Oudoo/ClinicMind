import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  numeric,
  pgEnum,
  index,
  uniqueIndex,
  date,
} from "drizzle-orm/pg-core";
import { tenants, users } from "./tenancy.js";

export const clientStatusEnum = pgEnum("client_status", [
  "prospect",
  "onboarding",
  "active",
  "paused",
  "offboarded",
]);

export const projectStatusEnum = pgEnum("project_status", [
  "planning",
  "active",
  "on_hold",
  "completed",
  "cancelled",
]);

export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Used in the client portal URL: /client/[slug] */
    slug: text("slug").notNull(),
    industry: text("industry"),
    websiteUrl: text("website_url"),
    status: clientStatusEnum("status").notNull().default("active"),
    accountManagerId: uuid("account_manager_id").references(() => users.id, {
      onDelete: "set null",
    }),
    monthlyRetainer: numeric("monthly_retainer", { precision: 12, scale: 2 }),
    /** Gamified milestone targets: revenue, leads, ROAS etc. */
    milestoneTargets: jsonb("milestone_targets").notNull().default([]),
    settings: jsonb("settings").notNull().default({}),
    onboardedAt: date("onboarded_at"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("clients_tenant_slug_idx").on(t.tenantId, t.slug),
    index("clients_tenant_idx").on(t.tenantId),
  ]
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    status: projectStatusEnum("status").notNull().default("active"),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    budget: numeric("budget", { precision: 12, scale: 2 }),
    startDate: date("start_date"),
    endDate: date("end_date"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("projects_tenant_idx").on(t.tenantId),
    index("projects_client_idx").on(t.clientId),
  ]
);
