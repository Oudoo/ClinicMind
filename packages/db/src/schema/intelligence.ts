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
import { clients } from "./clients.js";

export const dmaicPhaseEnum = pgEnum("dmaic_phase", [
  "define",
  "measure",
  "analyze",
  "improve",
  "control",
  "completed",
]);

/**
 * Automated DMAIC Generator — converts findings into structured
 * Define/Measure/Analyze/Improve/Control projects with generated tasks.
 */
export const dmaicProjects = pgTable(
  "dmaic_projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    problemStatement: text("problem_statement").notNull(),
    currentPhase: dmaicPhaseEnum("current_phase").notNull().default("define"),
    /**
     * Full phase content keyed by phase:
     * {define: {goal, scope, stakeholders}, measure: {kpis, baselines}, ...}
     */
    phases: jsonb("phases").notNull().default({}),
    /** Generated timeline: [{phase, startDate, endDate}] */
    timeline: jsonb("timeline").notNull().default([]),
    confidenceScore: numeric("confidence_score", { precision: 5, scale: 2 }),
    dataSources: jsonb("data_sources").notNull().default([]),
    evidenceCount: integer("evidence_count").notNull().default(0),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    aiGenerated: integer("ai_generated").notNull().default(1),
    sourceFindingType: text("source_finding_type"),
    sourceFindingId: uuid("source_finding_id"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("dmaic_tenant_idx").on(t.tenantId),
    index("dmaic_client_idx").on(t.clientId),
  ]
);

export const forecastStatusEnum = pgEnum("forecast_status", [
  "queued",
  "running",
  "completed",
  "failed",
]);

export const forecasts = pgTable(
  "forecasts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    horizonDays: integer("horizon_days").notNull().default(30),
    status: forecastStatusEnum("status").notNull().default("queued"),
    /** Point forecasts with bounds: [{date, value, lower, upper}] */
    points: jsonb("points").notNull().default([]),
    method: text("method").notNull().default("holt_winters"),
    /** AI Confidence Framework — mandatory on every forecast */
    confidenceScore: numeric("confidence_score", { precision: 5, scale: 2 }),
    dataSources: jsonb("data_sources").notNull().default([]),
    evidenceCount: integer("evidence_count").notNull().default(0),
    /** Historical observations used (count + window) for traceability */
    trainingWindow: jsonb("training_window").notNull().default({}),
    /** Backtest accuracy: MAPE on holdout */
    backtestMape: numeric("backtest_mape", { precision: 7, scale: 3 }),
    narrative: text("narrative"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("forecasts_client_idx").on(t.clientId, t.metric)]
);

/**
 * Lost Opportunity Quantifier — retroactive missed-revenue ranges due to
 * missed seasonal trends, with confidence scores.
 */
export const lostOpportunities = pgTable(
  "lost_opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    metric: text("metric").notNull(),
    missedValueLow: numeric("missed_value_low", { precision: 18, scale: 2 }).notNull(),
    missedValueHigh: numeric("missed_value_high", { precision: 18, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("USD"),
    methodology: text("methodology").notNull(),
    confidenceScore: numeric("confidence_score", { precision: 5, scale: 2 }),
    dataSources: jsonb("data_sources").notNull().default([]),
    evidenceCount: integer("evidence_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("lost_opps_client_idx").on(t.clientId)]
);

/**
 * Seasonality patterns powering heatmaps and future budget-scaling maps.
 */
export const seasonalityPatterns = pgTable(
  "seasonality_patterns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    /** Heatmap cells: [{month, weekOfMonth?, index, label}] index=1.0 is baseline */
    heatmap: jsonb("heatmap").notNull().default([]),
    /** Recommended budget multipliers for upcoming periods */
    budgetScalingMap: jsonb("budget_scaling_map").notNull().default([]),
    yearsOfData: numeric("years_of_data", { precision: 4, scale: 1 }),
    confidenceScore: numeric("confidence_score", { precision: 5, scale: 2 }),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("seasonality_client_idx").on(t.clientId, t.metric)]
);

export const healthScores = pgTable(
  "health_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    /** 0-100 composite */
    score: numeric("score", { precision: 5, scale: 2 }).notNull(),
    /** Component breakdown: performance, engagement, delivery, sentiment */
    components: jsonb("components").notNull().default({}),
    trend: text("trend").notNull().default("stable"),
    drivers: jsonb("drivers").notNull().default([]),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("health_scores_client_idx").on(t.clientId, t.computedAt)]
);

export const aeoAuditStatusEnum = pgEnum("aeo_audit_status", [
  "queued",
  "crawling",
  "analyzing",
  "completed",
  "failed",
]);

/**
 * AEO/GEO Content Auditor — evaluates site copy against generative-AI
 * search standards (structured data, schema markup, citeable quotes).
 */
export const aeoAudits = pgTable(
  "aeo_audits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    targetUrl: text("target_url").notNull(),
    status: aeoAuditStatusEnum("status").notNull().default("queued"),
    pagesCrawled: integer("pages_crawled").notNull().default(0),
    /** 0-100 overall AEO readiness */
    overallScore: numeric("overall_score", { precision: 5, scale: 2 }),
    /** Per-dimension scores: structuredData, schemaMarkup, citeableQuotes, answerability, freshness */
    dimensionScores: jsonb("dimension_scores").notNull().default({}),
    /** Page-level findings: [{url, issues[], strengths[], score}] */
    pageFindings: jsonb("page_findings").notNull().default([]),
    recommendations: jsonb("recommendations").notNull().default([]),
    confidenceScore: numeric("confidence_score", { precision: 5, scale: 2 }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("aeo_audits_client_idx").on(t.clientId)]
);

export const leadAuditStatusEnum = pgEnum("lead_audit_status", [
  "submitted",
  "processing",
  "completed",
  "failed",
  "converted",
]);

/**
 * Interactive Business Audit Lead Magnet submissions — public widget for
 * prospective clients; completed audits are upsell triggers.
 */
export const leadAudits = pgTable(
  "lead_audits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    companyName: text("company_name").notNull(),
    contactName: text("contact_name").notNull(),
    contactEmail: text("contact_email").notNull(),
    websiteUrl: text("website_url").notNull(),
    industry: text("industry"),
    monthlyAdBudget: text("monthly_ad_budget"),
    primaryGoal: text("primary_goal"),
    /** Widget questionnaire answers */
    responses: jsonb("responses").notNull().default({}),
    status: leadAuditStatusEnum("status").notNull().default("submitted"),
    /** Generated high-level audit report (markdown) */
    auditReport: text("audit_report"),
    auditScore: numeric("audit_score", { precision: 5, scale: 2 }),
    auditFindings: jsonb("audit_findings").notNull().default([]),
    utmSource: text("utm_source"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("lead_audits_tenant_idx").on(t.tenantId, t.createdAt)]
);

/**
 * Process Intelligence Engine — operational bottleneck findings computed
 * from CRM + tickets + tasks + SLA + funnel data. The non-marketing
 * Business Advisory layer.
 */
export const processInsights = pgTable(
  "process_insights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
    /** bottleneck | cycle_time | rework | approval_delay | capacity | funnel_leak */
    insightType: text("insight_type").notNull(),
    title: text("title").notNull(),
    finding: text("finding").notNull(),
    recommendedAction: text("recommended_action").notNull(),
    /** Supporting numbers: {leadVolumeChange, conversionChange, slaBreachRate...} */
    evidence: jsonb("evidence").notNull().default({}),
    evidenceCount: integer("evidence_count").notNull().default(0),
    confidenceScore: numeric("confidence_score", { precision: 5, scale: 2 }),
    dataSources: jsonb("data_sources").notNull().default([]),
    severity: text("severity").notNull().default("medium"),
    status: text("status").notNull().default("open"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("process_insights_tenant_idx").on(t.tenantId, t.computedAt)]
);
