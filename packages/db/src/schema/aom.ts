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
  vector,
} from "drizzle-orm/pg-core";
import { tenants, users } from "./tenancy.js";
import { clients } from "./clients.js";

/**
 * Agency Operating Memory (AOM) — the competitive moat.
 * Every meaningful artifact (meetings, emails, reports, decisions, tickets,
 * tasks, recommendations, change requests) is linked and semantically
 * searchable through pgvector embeddings.
 */

export const knowledgeDocTypeEnum = pgEnum("knowledge_doc_type", [
  "report",
  "email",
  "note",
  "qbr",
  "expectation_baseline",
  "sow",
  "digest",
  "research",
  "other",
]);

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
    type: knowledgeDocTypeEnum("type").notNull().default("note"),
    title: text("title").notNull(),
    contentMarkdown: text("content_markdown").notNull(),
    /** Optional binary attachment in object storage */
    storageKey: text("storage_key"),
    sourceEntityType: text("source_entity_type"),
    sourceEntityId: uuid("source_entity_id"),
    tags: jsonb("tags").notNull().default([]),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("kdocs_tenant_idx").on(t.tenantId),
    index("kdocs_client_idx").on(t.clientId),
  ]
);

export const recommendationStatusEnum = pgEnum("recommendation_status", [
  "proposed",
  "verified",
  "presented",
  "approved",
  "rejected",
  "implemented",
  "measured",
]);

export const recommendations = pgTable(
  "recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** marketing | operations | creative | budget | technical */
    category: text("category").notNull().default("marketing"),
    status: recommendationStatusEnum("status").notNull().default("proposed"),
    /**
     * AI Recommendation Verification Engine output:
     * [{claim, evidence, metricRecordIds, sourceRequestIds, verdict}]
     */
    evidence: jsonb("evidence").notNull().default([]),
    evidenceCount: integer("evidence_count").notNull().default(0),
    /** AI Confidence Framework */
    confidenceScore: numeric("confidence_score", { precision: 5, scale: 2 }),
    dataSources: jsonb("data_sources").notNull().default([]),
    expectedImpact: jsonb("expected_impact").notNull().default({}),
    /** Measured impact after implementation, for AOM historical queries */
    measuredImpact: jsonb("measured_impact").notNull().default({}),
    proposedBy: uuid("proposed_by").references(() => users.id, { onDelete: "set null" }),
    aiGenerated: integer("ai_generated").notNull().default(0),
    presentedAt: timestamp("presented_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    implementedAt: timestamp("implemented_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("recommendations_tenant_idx").on(t.tenantId),
    index("recommendations_client_status_idx").on(t.clientId, t.status),
  ]
);

export const decisionOutcomeEnum = pgEnum("decision_outcome", [
  "approved",
  "rejected",
  "deferred",
  "modified",
]);

/**
 * Decisions — explicit records of what was decided, by whom, and why.
 * Linked to recommendations, meetings, or change requests.
 */
export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    outcome: decisionOutcomeEnum("outcome").notNull(),
    reason: text("reason"),
    /** Free-text name + optional user link; client-side approvers may not be users */
    approvedByName: text("approved_by_name"),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Source link: recommendation | meeting | change_request | cat_approval */
    sourceEntityType: text("source_entity_type"),
    sourceEntityId: uuid("source_entity_id"),
    context: jsonb("context").notNull().default({}),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("decisions_tenant_idx").on(t.tenantId),
    index("decisions_client_idx").on(t.clientId),
  ]
);

export const changeRequestStatusEnum = pgEnum("change_request_status", [
  "submitted",
  "under_review",
  "approved",
  "rejected",
  "implemented",
]);

export const changeRequests = pgTable(
  "change_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    status: changeRequestStatusEnum("status").notNull().default("submitted"),
    requestedByName: text("requested_by_name"),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    impactAssessment: jsonb("impact_assessment").notNull().default({}),
    estimatedManDays: numeric("estimated_man_days", { precision: 7, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("change_requests_client_idx").on(t.clientId)]
);

/**
 * Semantic search layer over the entire AOM. Each row is a chunk of a
 * source entity embedded with the configured embedding model (1536 dims,
 * OpenAI text-embedding-3-small by default).
 */
export const aomEmbeddings = pgTable(
  "aom_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
    /** meeting | transcript | knowledge_document | recommendation | decision | ticket | task | change_request */
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    chunkIndex: integer("chunk_index").notNull().default(0),
    chunkText: text("chunk_text").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }),
    embeddingModel: text("embedding_model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("aom_embeddings_entity_idx").on(t.tenantId, t.entityType, t.entityId),
    index("aom_embeddings_vector_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ]
);

/**
 * Explicit graph links between AOM entities (meeting -> recommendation ->
 * decision -> task...), powering historical context queries.
 */
export const aomLinks = pgTable(
  "aom_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    fromEntityType: text("from_entity_type").notNull(),
    fromEntityId: uuid("from_entity_id").notNull(),
    toEntityType: text("to_entity_type").notNull(),
    toEntityId: uuid("to_entity_id").notNull(),
    /** generated_from | approved_by | implements | references | supersedes */
    linkType: text("link_type").notNull().default("references"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("aom_links_from_idx").on(t.tenantId, t.fromEntityType, t.fromEntityId),
    index("aom_links_to_idx").on(t.tenantId, t.toEntityType, t.toEntityId),
  ]
);
