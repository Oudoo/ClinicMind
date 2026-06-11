CREATE TYPE "public"."tenant_status" AS ENUM('active', 'suspended', 'trial', 'churned');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'invited', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."client_status" AS ENUM('prospect', 'onboarding', 'active', 'paused', 'offboarded');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('planning', 'active', 'on_hold', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('meta', 'ga4', 'google_ads', 'tiktok', 'linkedin', 'x', 'zoho_crm', 'hubspot', 'salesforce', 'dynamics', 'odoo');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('connected', 'syncing', 'error', 'token_expired', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."sync_log_status" AS ENUM('started', 'success', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."ticket_priority" AS ENUM('low', 'medium', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('open', 'in_progress', 'waiting_on_client', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."meeting_status" AS ENUM('scheduled', 'awaiting_prereqs', 'recorded', 'transcribing', 'analyzing', 'analyzed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."sow_status" AS ENUM('draft', 'internal_review', 'sent', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."transcription_engine" AS ENUM('whisper_local', 'whisper_api');--> statement-breakpoint
CREATE TYPE "public"."change_request_status" AS ENUM('submitted', 'under_review', 'approved', 'rejected', 'implemented');--> statement-breakpoint
CREATE TYPE "public"."decision_outcome" AS ENUM('approved', 'rejected', 'deferred', 'modified');--> statement-breakpoint
CREATE TYPE "public"."knowledge_doc_type" AS ENUM('report', 'email', 'note', 'qbr', 'expectation_baseline', 'sow', 'digest', 'research', 'other');--> statement-breakpoint
CREATE TYPE "public"."recommendation_status" AS ENUM('proposed', 'verified', 'presented', 'approved', 'rejected', 'implemented', 'measured');--> statement-breakpoint
CREATE TYPE "public"."aeo_audit_status" AS ENUM('queued', 'crawling', 'analyzing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."dmaic_phase" AS ENUM('define', 'measure', 'analyze', 'improve', 'control', 'completed');--> statement-breakpoint
CREATE TYPE "public"."forecast_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."lead_audit_status" AS ENUM('submitted', 'processing', 'completed', 'failed', 'converted');--> statement-breakpoint
CREATE TYPE "public"."ab_pilot_status" AS ENUM('scheduled', 'running', 'completed', 'promoted', 'stopped');--> statement-breakpoint
CREATE TYPE "public"."cat_approval_status" AS ENUM('pending', 'approved', 'rejected', 'changes_requested');--> statement-breakpoint
CREATE TYPE "public"."creative_asset_status" AS ENUM('draft', 'internal_review', 'awaiting_client_approval', 'approved', 'rejected', 'in_pilot', 'scaled', 'retired');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'issued', 'paid', 'overdue', 'void');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."ai_job_status" AS ENUM('queued', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('in_app', 'email', 'slack', 'teams', 'webhook');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_retention_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"data_category" text NOT NULL,
	"retention_days" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_enforced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role_id" uuid,
	"client_id" uuid,
	"token" text NOT NULL,
	"invited_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" "tenant_status" DEFAULT 'active' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"avatar_url" text,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"is_super_admin" boolean DEFAULT false NOT NULL,
	"client_id" uuid,
	"last_login_at" timestamp with time zone,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"feature_id" uuid NOT NULL,
	"enabled" boolean NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "features" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"default_enabled" boolean DEFAULT true NOT NULL,
	"is_beta" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"industry" text,
	"website_url" text,
	"status" "client_status" DEFAULT 'active' NOT NULL,
	"account_manager_id" uuid,
	"monthly_retainer" numeric(12, 2),
	"milestone_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"onboarded_at" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "project_status" DEFAULT 'active' NOT NULL,
	"owner_id" uuid,
	"budget" numeric(12, 2),
	"start_date" date,
	"end_date" date,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid,
	"cache_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source_trace" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "api_quota_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"throttled_count" integer DEFAULT 0 NOT NULL,
	"quota_limit" integer,
	"backoff_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_kill_switches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"status" "sync_log_status" NOT NULL,
	"operation" text NOT NULL,
	"api_request_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"records_fetched" integer DEFAULT 0 NOT NULL,
	"records_stored" integer DEFAULT 0 NOT NULL,
	"sanity_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"duration_ms" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"name" text NOT NULL,
	"external_account_id" text,
	"encrypted_credentials" text,
	"status" "integration_status" DEFAULT 'disconnected' NOT NULL,
	"token_expires_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_successful_sync_at" timestamp with time zone,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"sync_frequency_minutes" integer DEFAULT 360 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"metric" text NOT NULL,
	"dimensions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"date" date NOT NULL,
	"value" numeric(18, 4) NOT NULL,
	"currency" text,
	"source_request_id" text,
	"source_reference_url" text,
	"sanity_status" text DEFAULT 'passed' NOT NULL,
	"sanity_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"is_internal" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sprint_showcases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"video_storage_key" text,
	"video_duration_seconds" integer,
	"sprint_start" date,
	"sprint_end" date,
	"highlights" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sub_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "task_status" DEFAULT 'todo' NOT NULL,
	"assignee_id" uuid,
	"completed_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid,
	"project_id" uuid,
	"dmaic_project_id" uuid,
	"dmaic_phase" text,
	"title" text NOT NULL,
	"description" text,
	"status" "task_status" DEFAULT 'todo' NOT NULL,
	"priority" "ticket_priority" DEFAULT 'medium' NOT NULL,
	"assignee_id" uuid,
	"estimate_hours" numeric(7, 2),
	"due_date" date,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"rework_count" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_scorecards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"tasks_completed" integer DEFAULT 0 NOT NULL,
	"tasks_on_time" integer DEFAULT 0 NOT NULL,
	"avg_cycle_time_hours" numeric(10, 2),
	"sla_compliance_pct" numeric(5, 2),
	"rework_rate_pct" numeric(5, 2),
	"tickets_resolved" integer DEFAULT 0 NOT NULL,
	"avg_first_response_minutes" numeric(10, 2),
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid,
	"project_id" uuid,
	"number" integer NOT NULL,
	"subject" text NOT NULL,
	"description" text,
	"status" "ticket_status" DEFAULT 'open' NOT NULL,
	"priority" "ticket_priority" DEFAULT 'medium' NOT NULL,
	"requester_id" uuid,
	"assignee_id" uuid,
	"sla_due_at" timestamp with time zone,
	"first_response_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"title" text NOT NULL,
	"agenda" text,
	"status" "meeting_status" DEFAULT 'scheduled' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"duration_minutes" integer,
	"attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prerequisite_form_id" uuid,
	"prerequisite_responses" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recording_storage_key" text,
	"recording_mime_type" text,
	"organizer_id" uuid,
	"extracted_requirements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extracted_challenges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"action_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expectation_baseline" text,
	"analysis_confidence" numeric(5, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prerequisite_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid,
	"name" text NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sow_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"meeting_id" uuid,
	"title" text NOT NULL,
	"status" "sow_status" DEFAULT 'draft' NOT NULL,
	"scope_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"technical_feasibility" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"man_day_estimates" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"option_tiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"document_markdown" text,
	"generation_confidence" numeric(5, 2),
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"engine" "transcription_engine" NOT NULL,
	"language" text,
	"full_text" text NOT NULL,
	"segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"word_count" integer,
	"processing_time_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aom_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"chunk_text" text NOT NULL,
	"embedding" vector(1536),
	"embedding_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aom_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"from_entity_type" text NOT NULL,
	"from_entity_id" uuid NOT NULL,
	"to_entity_type" text NOT NULL,
	"to_entity_id" uuid NOT NULL,
	"link_type" text DEFAULT 'references' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"status" "change_request_status" DEFAULT 'submitted' NOT NULL,
	"requested_by_name" text,
	"requested_by_user_id" uuid,
	"impact_assessment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"estimated_man_days" numeric(7, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid,
	"title" text NOT NULL,
	"outcome" "decision_outcome" NOT NULL,
	"reason" text,
	"approved_by_name" text,
	"approved_by_user_id" uuid,
	"source_entity_type" text,
	"source_entity_id" uuid,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid,
	"type" "knowledge_doc_type" DEFAULT 'note' NOT NULL,
	"title" text NOT NULL,
	"content_markdown" text NOT NULL,
	"storage_key" text,
	"source_entity_type" text,
	"source_entity_id" uuid,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"author_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"category" text DEFAULT 'marketing' NOT NULL,
	"status" "recommendation_status" DEFAULT 'proposed' NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_count" integer DEFAULT 0 NOT NULL,
	"confidence_score" numeric(5, 2),
	"data_sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_impact" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"measured_impact" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"proposed_by" uuid,
	"ai_generated" integer DEFAULT 0 NOT NULL,
	"presented_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"implemented_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aeo_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"target_url" text NOT NULL,
	"status" "aeo_audit_status" DEFAULT 'queued' NOT NULL,
	"pages_crawled" integer DEFAULT 0 NOT NULL,
	"overall_score" numeric(5, 2),
	"dimension_scores" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"page_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommendations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence_score" numeric(5, 2),
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dmaic_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"title" text NOT NULL,
	"problem_statement" text NOT NULL,
	"current_phase" "dmaic_phase" DEFAULT 'define' NOT NULL,
	"phases" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"timeline" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence_score" numeric(5, 2),
	"data_sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_count" integer DEFAULT 0 NOT NULL,
	"owner_id" uuid,
	"ai_generated" integer DEFAULT 1 NOT NULL,
	"source_finding_type" text,
	"source_finding_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forecasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"horizon_days" integer DEFAULT 30 NOT NULL,
	"status" "forecast_status" DEFAULT 'queued' NOT NULL,
	"points" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"method" text DEFAULT 'holt_winters' NOT NULL,
	"confidence_score" numeric(5, 2),
	"data_sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_count" integer DEFAULT 0 NOT NULL,
	"training_window" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"backtest_mape" numeric(7, 3),
	"narrative" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "health_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"score" numeric(5, 2) NOT NULL,
	"components" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trend" text DEFAULT 'stable' NOT NULL,
	"drivers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_name" text NOT NULL,
	"contact_name" text NOT NULL,
	"contact_email" text NOT NULL,
	"website_url" text NOT NULL,
	"industry" text,
	"monthly_ad_budget" text,
	"primary_goal" text,
	"responses" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "lead_audit_status" DEFAULT 'submitted' NOT NULL,
	"audit_report" text,
	"audit_score" numeric(5, 2),
	"audit_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"utm_source" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lost_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"title" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"metric" text NOT NULL,
	"missed_value_low" numeric(18, 2) NOT NULL,
	"missed_value_high" numeric(18, 2) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"methodology" text NOT NULL,
	"confidence_score" numeric(5, 2),
	"data_sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "process_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid,
	"insight_type" text NOT NULL,
	"title" text NOT NULL,
	"finding" text NOT NULL,
	"recommended_action" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_count" integer DEFAULT 0 NOT NULL,
	"confidence_score" numeric(5, 2),
	"data_sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seasonality_patterns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"heatmap" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"budget_scaling_map" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"years_of_data" numeric(4, 1),
	"confidence_score" numeric(5, 2),
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ab_pilots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"creative_asset_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "ab_pilot_status" DEFAULT 'scheduled' NOT NULL,
	"platform" text NOT NULL,
	"external_campaign_id" text,
	"daily_budget" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"start_date" date,
	"end_date" date,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verdict" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence_score" numeric(5, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cat_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"creative_asset_id" uuid NOT NULL,
	"status" "cat_approval_status" DEFAULT 'pending' NOT NULL,
	"requested_by" uuid,
	"decided_by_user_id" uuid,
	"decided_by_name" text,
	"decision_note" text,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "creative_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"asset_type" text NOT NULL,
	"status" "creative_asset_status" DEFAULT 'draft' NOT NULL,
	"storage_key" text,
	"preview_url" text,
	"copy_text" text,
	"platforms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_tracking" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid,
	"project_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"feature" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"ai_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid,
	"subscription_id" uuid,
	"number" text NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"line_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subtotal" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"issued_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"monthly_price" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"current_period_start" date NOT NULL,
	"current_period_end" date NOT NULL,
	"cancel_at_period_end" integer DEFAULT 0 NOT NULL,
	"external_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"meter" text NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"usage_date" date NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid,
	"job_type" text NOT NULL,
	"status" "ai_job_status" DEFAULT 'queued' NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"queue_job_id" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_id" uuid,
	"actor_type" text DEFAULT 'user' NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"backup_type" text NOT NULL,
	"storage_key" text,
	"size_bytes" text,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "domain_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"dispatch_status" text DEFAULT 'pending' NOT NULL,
	"handler_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "feature_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'open' NOT NULL,
	"submitted_by" uuid,
	"vote_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"template_key" text NOT NULL,
	"channels" jsonb DEFAULT '["in_app"]'::jsonb NOT NULL,
	"audience" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"subject_template" text NOT NULL,
	"body_template" text NOT NULL,
	"channels" jsonb DEFAULT '["in_app"]'::jsonb NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"channel" "notification_channel" DEFAULT 'in_app' NOT NULL,
	"template_key" text,
	"title" text NOT NULL,
	"body" text,
	"link_url" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"queue_name" text NOT NULL,
	"job_name" text NOT NULL,
	"bull_job_id" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"payload_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"feature_request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_status" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"url" text NOT NULL,
	"event_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"encrypted_secret" text,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_retention_policies" ADD CONSTRAINT "data_retention_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_invites" ADD CONSTRAINT "tenant_invites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_invites" ADD CONSTRAINT "tenant_invites_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_invites" ADD CONSTRAINT "tenant_invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_account_manager_id_users_id_fk" FOREIGN KEY ("account_manager_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_cache" ADD CONSTRAINT "analytics_cache_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_cache" ADD CONSTRAINT "analytics_cache_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_quota_usage" ADD CONSTRAINT "api_quota_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_kill_switches" ADD CONSTRAINT "integration_kill_switches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_logs" ADD CONSTRAINT "integration_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_logs" ADD CONSTRAINT "integration_logs_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_records" ADD CONSTRAINT "metric_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_records" ADD CONSTRAINT "metric_records_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_records" ADD CONSTRAINT "metric_records_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_showcases" ADD CONSTRAINT "sprint_showcases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_showcases" ADD CONSTRAINT "sprint_showcases_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_showcases" ADD CONSTRAINT "sprint_showcases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_tasks" ADD CONSTRAINT "sub_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_tasks" ADD CONSTRAINT "sub_tasks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_tasks" ADD CONSTRAINT "sub_tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_scorecards" ADD CONSTRAINT "team_scorecards_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_scorecards" ADD CONSTRAINT "team_scorecards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_prerequisite_form_id_prerequisite_forms_id_fk" FOREIGN KEY ("prerequisite_form_id") REFERENCES "public"."prerequisite_forms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_organizer_id_users_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prerequisite_forms" ADD CONSTRAINT "prerequisite_forms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prerequisite_forms" ADD CONSTRAINT "prerequisite_forms_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sow_documents" ADD CONSTRAINT "sow_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sow_documents" ADD CONSTRAINT "sow_documents_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sow_documents" ADD CONSTRAINT "sow_documents_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sow_documents" ADD CONSTRAINT "sow_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aom_embeddings" ADD CONSTRAINT "aom_embeddings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aom_embeddings" ADD CONSTRAINT "aom_embeddings_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aom_links" ADD CONSTRAINT "aom_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aeo_audits" ADD CONSTRAINT "aeo_audits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aeo_audits" ADD CONSTRAINT "aeo_audits_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmaic_projects" ADD CONSTRAINT "dmaic_projects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmaic_projects" ADD CONSTRAINT "dmaic_projects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmaic_projects" ADD CONSTRAINT "dmaic_projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_scores" ADD CONSTRAINT "health_scores_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_scores" ADD CONSTRAINT "health_scores_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_audits" ADD CONSTRAINT "lead_audits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lost_opportunities" ADD CONSTRAINT "lost_opportunities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lost_opportunities" ADD CONSTRAINT "lost_opportunities_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_insights" ADD CONSTRAINT "process_insights_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_insights" ADD CONSTRAINT "process_insights_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasonality_patterns" ADD CONSTRAINT "seasonality_patterns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasonality_patterns" ADD CONSTRAINT "seasonality_patterns_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ab_pilots" ADD CONSTRAINT "ab_pilots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ab_pilots" ADD CONSTRAINT "ab_pilots_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ab_pilots" ADD CONSTRAINT "ab_pilots_creative_asset_id_creative_assets_id_fk" FOREIGN KEY ("creative_asset_id") REFERENCES "public"."creative_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cat_approvals" ADD CONSTRAINT "cat_approvals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cat_approvals" ADD CONSTRAINT "cat_approvals_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cat_approvals" ADD CONSTRAINT "cat_approvals_creative_asset_id_creative_assets_id_fk" FOREIGN KEY ("creative_asset_id") REFERENCES "public"."creative_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cat_approvals" ADD CONSTRAINT "cat_approvals_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cat_approvals" ADD CONSTRAINT "cat_approvals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_assets" ADD CONSTRAINT "creative_assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_assets" ADD CONSTRAINT "creative_assets_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_assets" ADD CONSTRAINT "creative_assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_assets" ADD CONSTRAINT "creative_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_tracking" ADD CONSTRAINT "cost_tracking_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_tracking" ADD CONSTRAINT "cost_tracking_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_requests" ADD CONSTRAINT "feature_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_requests" ADD CONSTRAINT "feature_requests_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_requests" ADD CONSTRAINT "feature_requests_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_jobs" ADD CONSTRAINT "queue_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_feature_request_id_feature_requests_id_fk" FOREIGN KEY ("feature_request_id") REFERENCES "public"."feature_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_idx" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_tenant_idx" ON "api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_tenant_category_idx" ON "data_retention_policies" USING btree ("tenant_id","data_category");--> statement-breakpoint
CREATE UNIQUE INDEX "permissions_key_idx" ON "permissions" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_name_idx" ON "roles" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_invites_token_idx" ON "tenant_invites" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_idx" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_email_idx" ON "users" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE INDEX "users_tenant_idx" ON "users" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flags_tenant_feature_idx" ON "feature_flags" USING btree ("tenant_id","feature_id");--> statement-breakpoint
CREATE UNIQUE INDEX "features_key_idx" ON "features" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_tenant_slug_idx" ON "clients" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "clients_tenant_idx" ON "clients" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "projects_tenant_idx" ON "projects" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "projects_client_idx" ON "projects" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_cache_key_idx" ON "analytics_cache" USING btree ("tenant_id","cache_key");--> statement-breakpoint
CREATE UNIQUE INDEX "api_quota_window_idx" ON "api_quota_usage" USING btree ("tenant_id","provider","window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "kill_switch_idx" ON "integration_kill_switches" USING btree ("tenant_id","provider");--> statement-breakpoint
CREATE INDEX "integration_logs_tenant_idx" ON "integration_logs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "integration_logs_integration_idx" ON "integration_logs" USING btree ("integration_id","started_at");--> statement-breakpoint
CREATE INDEX "integrations_tenant_idx" ON "integrations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "integrations_client_idx" ON "integrations" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "integrations_status_idx" ON "integrations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_records_unique_fact_idx" ON "metric_records" USING btree ("integration_id","metric","date","dimensions");--> statement-breakpoint
CREATE INDEX "metric_records_tenant_client_idx" ON "metric_records" USING btree ("tenant_id","client_id","date");--> statement-breakpoint
CREATE INDEX "metric_records_metric_idx" ON "metric_records" USING btree ("client_id","metric","date");--> statement-breakpoint
CREATE INDEX "comments_entity_idx" ON "comments" USING btree ("tenant_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "showcases_client_idx" ON "sprint_showcases" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "subtasks_task_idx" ON "sub_tasks" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "tasks_tenant_idx" ON "tasks" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("assignee_id","status");--> statement-breakpoint
CREATE INDEX "tasks_dmaic_idx" ON "tasks" USING btree ("dmaic_project_id");--> statement-breakpoint
CREATE INDEX "scorecards_user_period_idx" ON "team_scorecards" USING btree ("user_id","period_start");--> statement-breakpoint
CREATE INDEX "tickets_tenant_idx" ON "tickets" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tickets_client_idx" ON "tickets" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "meetings_tenant_idx" ON "meetings" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "meetings_client_idx" ON "meetings" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "prereq_forms_tenant_idx" ON "prerequisite_forms" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sow_client_idx" ON "sow_documents" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "transcripts_meeting_idx" ON "transcripts" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "aom_embeddings_entity_idx" ON "aom_embeddings" USING btree ("tenant_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "aom_embeddings_vector_idx" ON "aom_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "aom_links_from_idx" ON "aom_links" USING btree ("tenant_id","from_entity_type","from_entity_id");--> statement-breakpoint
CREATE INDEX "aom_links_to_idx" ON "aom_links" USING btree ("tenant_id","to_entity_type","to_entity_id");--> statement-breakpoint
CREATE INDEX "change_requests_client_idx" ON "change_requests" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "decisions_tenant_idx" ON "decisions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "decisions_client_idx" ON "decisions" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "kdocs_tenant_idx" ON "knowledge_documents" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "kdocs_client_idx" ON "knowledge_documents" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "recommendations_tenant_idx" ON "recommendations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "recommendations_client_status_idx" ON "recommendations" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "aeo_audits_client_idx" ON "aeo_audits" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "dmaic_tenant_idx" ON "dmaic_projects" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "dmaic_client_idx" ON "dmaic_projects" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "forecasts_client_idx" ON "forecasts" USING btree ("client_id","metric");--> statement-breakpoint
CREATE INDEX "health_scores_client_idx" ON "health_scores" USING btree ("client_id","computed_at");--> statement-breakpoint
CREATE INDEX "lead_audits_tenant_idx" ON "lead_audits" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "lost_opps_client_idx" ON "lost_opportunities" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "process_insights_tenant_idx" ON "process_insights" USING btree ("tenant_id","computed_at");--> statement-breakpoint
CREATE INDEX "seasonality_client_idx" ON "seasonality_patterns" USING btree ("client_id","metric");--> statement-breakpoint
CREATE INDEX "ab_pilots_client_idx" ON "ab_pilots" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "cat_approvals_client_idx" ON "cat_approvals" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "creative_assets_client_idx" ON "creative_assets" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "cost_tracking_tenant_idx" ON "cost_tracking" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "cost_tracking_feature_idx" ON "cost_tracking" USING btree ("tenant_id","feature");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_tenant_number_idx" ON "invoices" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "invoices_tenant_idx" ON "invoices" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_key_idx" ON "plans" USING btree ("key");--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_idx" ON "subscriptions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "usage_tenant_meter_idx" ON "usage_records" USING btree ("tenant_id","meter","usage_date");--> statement-breakpoint
CREATE INDEX "ai_jobs_tenant_idx" ON "ai_jobs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "ai_jobs_type_idx" ON "ai_jobs" USING btree ("job_type","status");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_idx" ON "audit_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "backup_records_type_idx" ON "backup_records" USING btree ("backup_type","started_at");--> statement-breakpoint
CREATE INDEX "domain_events_type_idx" ON "domain_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "domain_events_tenant_idx" ON "domain_events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "feature_requests_tenant_idx" ON "feature_requests" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "notif_rules_event_idx" ON "notification_rules" USING btree ("tenant_id","event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "notif_templates_tenant_key_idx" ON "notification_templates" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "notifications_tenant_idx" ON "notifications" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "queue_jobs_queue_idx" ON "queue_jobs" USING btree ("queue_name","status");--> statement-breakpoint
CREATE INDEX "queue_jobs_bull_idx" ON "queue_jobs" USING btree ("bull_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "votes_unique_idx" ON "votes" USING btree ("feature_request_id","user_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_idx" ON "webhook_deliveries" USING btree ("endpoint_id","status");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_tenant_idx" ON "webhook_endpoints" USING btree ("tenant_id");