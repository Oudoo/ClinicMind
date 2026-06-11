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
} from "drizzle-orm/pg-core";
import { tenants, users } from "./tenancy.js";
import { clients } from "./clients.js";

export const meetingStatusEnum = pgEnum("meeting_status", [
  "scheduled",
  "awaiting_prereqs",
  "recorded",
  "transcribing",
  "analyzing",
  "analyzed",
  "failed",
]);

export const transcriptionEngineEnum = pgEnum("transcription_engine", [
  "whisper_local",
  "whisper_api",
]);

/**
 * Pre-meeting prerequisite forms — global templates or client-specific.
 */
export const prerequisiteForms = pgTable(
  "prerequisite_forms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** null = global template applied to all clients */
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Field definitions: [{key,label,type,required,options}] */
    fields: jsonb("fields").notNull().default([]),
    isActive: integer("is_active").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("prereq_forms_tenant_idx").on(t.tenantId)]
);

export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    agenda: text("agenda"),
    status: meetingStatusEnum("status").notNull().default("scheduled"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    durationMinutes: integer("duration_minutes"),
    attendees: jsonb("attendees").notNull().default([]),
    /** Prerequisite form responses captured before the meeting */
    prerequisiteFormId: uuid("prerequisite_form_id").references(
      () => prerequisiteForms.id,
      { onDelete: "set null" }
    ),
    prerequisiteResponses: jsonb("prerequisite_responses").notNull().default({}),
    /** Object-storage key of the uploaded recording */
    recordingStorageKey: text("recording_storage_key"),
    recordingMimeType: text("recording_mime_type"),
    organizerId: uuid("organizer_id").references(() => users.id, { onDelete: "set null" }),
    /** AI-extracted output: requirements, challenges, action items */
    extractedRequirements: jsonb("extracted_requirements").notNull().default([]),
    extractedChallenges: jsonb("extracted_challenges").notNull().default([]),
    actionItems: jsonb("action_items").notNull().default([]),
    /** Generated Expectation Baseline document (markdown) */
    expectationBaseline: text("expectation_baseline"),
    analysisConfidence: numeric("analysis_confidence", { precision: 5, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("meetings_tenant_idx").on(t.tenantId),
    index("meetings_client_idx").on(t.clientId),
  ]
);

export const transcripts = pgTable(
  "transcripts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    engine: transcriptionEngineEnum("engine").notNull(),
    language: text("language"),
    fullText: text("full_text").notNull(),
    /** Timestamped segments: [{start, end, speaker, text}] */
    segments: jsonb("segments").notNull().default([]),
    wordCount: integer("word_count"),
    processingTimeMs: integer("processing_time_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("transcripts_meeting_idx").on(t.meetingId)]
);

export const sowStatusEnum = pgEnum("sow_status", [
  "draft",
  "internal_review",
  "sent",
  "approved",
  "rejected",
]);

/**
 * Automated SOW Generator output — parsed from meeting intelligence.
 */
export const sowDocuments = pgTable(
  "sow_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    meetingId: uuid("meeting_id").references(() => meetings.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    status: sowStatusEnum("status").notNull().default("draft"),
    /** Full structured SOW: scope items, deliverables, exclusions */
    scopeItems: jsonb("scope_items").notNull().default([]),
    technicalFeasibility: jsonb("technical_feasibility").notNull().default({}),
    /** Man-day estimates per scope item with totals */
    manDayEstimates: jsonb("man_day_estimates").notNull().default({}),
    /** Good / Better / Best option tiers with pricing deltas */
    optionTiers: jsonb("option_tiers").notNull().default([]),
    documentMarkdown: text("document_markdown"),
    generationConfidence: numeric("generation_confidence", { precision: 5, scale: 2 }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sow_client_idx").on(t.clientId)]
);
