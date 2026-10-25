-- CreateEnum
CREATE TYPE "AppointmentKind" AS ENUM ('CONSULTATION', 'FOLLOW_UP', 'PROCEDURE', 'CHECK_UP');

-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'CONSULTATION_BOOKED', 'CONSULTATION_ATTENDED', 'PROCEDURE_BOOKED', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('CLICK_TO_WHATSAPP_AD', 'INSTAGRAM_ORGANIC', 'WEBSITE', 'REFERRAL', 'WALK_IN', 'PHONE', 'OTHER');

-- CreateEnum
CREATE TYPE "LostReason" AS ENUM ('NO_RESPONSE', 'PRICE', 'DISTANCE', 'CHOSE_COMPETITOR', 'NOT_A_FIT', 'TIMING', 'OTHER');

-- CreateEnum
CREATE TYPE "ObjectionTag" AS ENUM ('PRICE', 'PAIN', 'DOWNTIME', 'RESULTS_DOUBT', 'TRUST', 'TIMING');

-- CreateEnum
CREATE TYPE "CampaignPlatform" AS ENUM ('META', 'GOOGLE', 'TIKTOK', 'OTHER');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'WAITING_ON_CLINIC', 'WAITING_ON_PATIENT', 'CLOSED');

-- CreateEnum
CREATE TYPE "MessageAuthor" AS ENUM ('PATIENT', 'AI', 'HUMAN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageDelivery" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'LOGGED');

-- CreateEnum
CREATE TYPE "ProcedureStatus" AS ENUM ('PLANNED', 'SIGNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('DEPOSIT', 'PAYMENT', 'REFUND', 'CONSULTATION_FEE');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'BANK_TRANSFER', 'WALLET', 'POS', 'OTHER');

-- CreateEnum
CREATE TYPE "ProtocolStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "ProtocolStepKind" AS ENUM ('INSTRUCTION', 'CHECK_IN', 'PHOTO_REQUEST');

-- CreateEnum
CREATE TYPE "EnrolmentStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'STOPPED');

-- CreateEnum
CREATE TYPE "ConciergeTaskStatus" AS ENUM ('PENDING', 'SENT', 'ANSWERED', 'MISSED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "TriageLevel" AS ENUM ('OK', 'WATCH', 'HIGH_RISK');

-- CreateEnum
CREATE TYPE "EscalationKind" AS ENUM ('CONCIERGE', 'LEAD_FOLLOW_UP', 'MANUAL');

-- CreateEnum
CREATE TYPE "EscalationStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('BOOKING_CREATED', 'BOOKING_CANCELLED', 'BOOKING_CONFLICT', 'NO_SHOW', 'REVIEW_PENDING', 'ESCALATION', 'FOLLOW_UP_OVERDUE', 'INTAKE_SUBMITTED', 'LEAD_NEW', 'MESSAGE_INBOUND', 'CHECK_IN_ANSWERED', 'PAYMENT_RECORDED', 'ALERT_RULE', 'WEEKLY_BRIEF', 'SYSTEM');

-- CreateEnum
CREATE TYPE "NotificationLevel" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertMetric" AS ENUM ('NO_SHOW_RATE', 'FIRST_RESPONSE_P50', 'FIRST_RESPONSE_P90', 'FOLLOW_UPS_OVERDUE', 'ESCALATIONS_UNACKNOWLEDGED', 'CHECK_IN_ANSWER_RATE', 'CAMPAIGN_WITHOUT_PROCEDURE', 'REVIEWS_PENDING', 'LOST_LEADS_PRICE_SHARE', 'LEAD_TO_CONSULTATION', 'REVENUE');

-- CreateEnum
CREATE TYPE "AlertComparator" AS ENUM ('ABOVE', 'BELOW');

-- CreateEnum
CREATE TYPE "IntakeLinkKind" AS ENUM ('OPEN', 'PATIENT');

-- CreateEnum
CREATE TYPE "IntakeStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AppointmentNoteKind" AS ENUM ('DICTATION', 'TEXT');

-- CreateEnum
CREATE TYPE "ReviewSource" AS ENUM ('GOOGLE_BUSINESS_PROFILE', 'MANUAL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TimelineKind" ADD VALUE 'PROCEDURE';
ALTER TYPE "TimelineKind" ADD VALUE 'PAYMENT';
ALTER TYPE "TimelineKind" ADD VALUE 'CHECK_IN';
ALTER TYPE "TimelineKind" ADD VALUE 'ESCALATION';
ALTER TYPE "TimelineKind" ADD VALUE 'INTAKE';
ALTER TYPE "TimelineKind" ADD VALUE 'LEAD';

-- DropIndex
DROP INDEX "knowledge_embeddings_embedding_idx";

-- DropIndex
DROP INDEX "patients_fullName_trgm_idx";

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "checkedInAt" TIMESTAMP(3),
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "kind" "AppointmentKind" NOT NULL DEFAULT 'CONSULTATION',
ADD COLUMN     "leadId" TEXT,
ADD COLUMN     "reminderSentAt" TIMESTAMP(3),
ADD COLUMN     "treatmentId" TEXT;

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "assignedToId" TEXT,
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "contactName" TEXT,
ADD COLUMN     "contactPhone" TEXT,
ADD COLUMN     "lastInboundAt" TIMESTAMP(3),
ADD COLUMN     "lastOutboundAt" TIMESTAMP(3),
ADD COLUMN     "leadId" TEXT,
ADD COLUMN     "objections" "ObjectionTag"[] DEFAULT ARRAY[]::"ObjectionTag"[],
ADD COLUMN     "objectionsConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN';

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "author" "MessageAuthor" NOT NULL DEFAULT 'HUMAN',
ADD COLUMN     "authorId" TEXT,
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "delivery" "MessageDelivery" NOT NULL DEFAULT 'LOGGED',
ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "failedReason" TEXT,
ADD COLUMN     "readAt" TIMESTAMP(3),
ADD COLUMN     "templateKey" TEXT;

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "city" TEXT,
ADD COLUMN     "nationalId" TEXT,
ADD COLUMN     "referredBy" TEXT,
ADD COLUMN     "source" "LeadSource";

-- CreateTable
CREATE TABLE "treatments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "consultationFee" INTEGER,
    "priceFrom" INTEGER,
    "priceTo" INTEGER,
    "depositAmount" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "treatments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" "CampaignPlatform" NOT NULL,
    "source" "LeadSource" NOT NULL DEFAULT 'CLICK_TO_WHATSAPP_AD',
    "treatmentId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_costs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT,
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "whatsapp" TEXT,
    "email" TEXT,
    "source" "LeadSource" NOT NULL DEFAULT 'OTHER',
    "campaignId" TEXT,
    "interests" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "stage" "LeadStage" NOT NULL DEFAULT 'NEW',
    "ownerId" TEXT,
    "lostReason" "LostReason",
    "lostAtStage" "LeadStage",
    "lostAt" TIMESTAMP(3),
    "lostNote" TEXT,
    "objections" "ObjectionTag"[] DEFAULT ARRAY[]::"ObjectionTag"[],
    "consultationAppointmentId" TEXT,
    "notes" TEXT,
    "firstTouchAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastContactAt" TIMESTAMP(3),
    "wonAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_follow_ups" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "ownerId" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "channel" "ChannelType",
    "doneAt" TIMESTAMP(3),
    "doneById" TEXT,
    "outcome" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'ar',
    "body" TEXT NOT NULL,
    "channel" "ChannelType",
    "category" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_integrations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" "ChannelType" NOT NULL,
    "provider" TEXT NOT NULL,
    "config" JSONB,
    "secretHash" TEXT,
    "secretPrefix" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "procedures" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "treatmentId" TEXT NOT NULL,
    "doctorId" TEXT,
    "appointmentId" TEXT,
    "visitId" TEXT,
    "consultationId" TEXT,
    "performedAt" TIMESTAMP(3) NOT NULL,
    "price" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "status" "ProcedureStatus" NOT NULL DEFAULT 'PLANNED',
    "signedAt" TIMESTAMP(3),
    "signedById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "procedures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "procedureId" TEXT,
    "appointmentId" TEXT,
    "leadId" TEXT,
    "kind" "PaymentKind" NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'CASH',
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "paidAt" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "importBatchId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "protocols" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "treatmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "ProtocolStatus" NOT NULL DEFAULT 'DRAFT',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "protocols_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "concierge_enrolments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "procedureId" TEXT NOT NULL,
    "protocolId" TEXT NOT NULL,
    "status" "EnrolmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "channel" "ChannelType" NOT NULL DEFAULT 'WHATSAPP',
    "language" TEXT NOT NULL DEFAULT 'ar',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "pauseReason" TEXT,
    "stoppedAt" TIMESTAMP(3),
    "stopReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "concierge_enrolments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "concierge_tasks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "enrolmentId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "kind" "ProtocolStepKind" NOT NULL,
    "title" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "status" "ConciergeTaskStatus" NOT NULL DEFAULT 'PENDING',
    "tokenHash" TEXT,
    "messageId" TEXT,
    "answeredAt" TIMESTAMP(3),
    "missedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "concierge_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "check_ins" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "enrolmentId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "satisfaction" INTEGER,
    "freeText" TEXT,
    "photoIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "triage" "TriageLevel" NOT NULL DEFAULT 'OK',
    "flags" JSONB NOT NULL DEFAULT '[]',
    "source" TEXT NOT NULL DEFAULT 'link',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escalations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "EscalationKind" NOT NULL,
    "level" "TriageLevel" NOT NULL DEFAULT 'WATCH',
    "status" "EscalationStatus" NOT NULL DEFAULT 'OPEN',
    "enrolmentId" TEXT,
    "checkInId" TEXT,
    "leadId" TEXT,
    "patientId" TEXT,
    "summary" TEXT NOT NULL,
    "details" JSONB,
    "assignedToId" TEXT,
    "outOfHours" BOOLEAN NOT NULL DEFAULT false,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "escalations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "level" "NotificationLevel" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "href" TEXT,
    "entity" TEXT,
    "entityId" TEXT,
    "readAt" TIMESTAMP(3),
    "emailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "inApp" JSONB NOT NULL DEFAULT '{}',
    "email" JSONB NOT NULL DEFAULT '{}',
    "browser" BOOLEAN NOT NULL DEFAULT false,
    "digestHour" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metric" "AlertMetric" NOT NULL,
    "comparator" "AlertComparator" NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "windowDays" INTEGER NOT NULL DEFAULT 7,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notifyRoles" "UserRole"[] DEFAULT ARRAY['CLINIC_OWNER']::"UserRole"[],
    "lastEvaluatedAt" TIMESTAMP(3),
    "lastFiredAt" TIMESTAMP(3),
    "lastValue" DOUBLE PRECISION,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_targets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "baseline" DOUBLE PRECISION,
    "target" DOUBLE PRECISION,
    "unit" TEXT,
    "dueAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metric_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intake_links" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "IntakeLinkKind" NOT NULL DEFAULT 'OPEN',
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "patientId" TEXT,
    "appointmentId" TEXT,
    "language" TEXT NOT NULL DEFAULT 'ar',
    "label" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "maxUses" INTEGER,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intake_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intake_submissions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "status" "IntakeStatus" NOT NULL DEFAULT 'PENDING',
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "data" JSONB NOT NULL,
    "matchedPatientId" TEXT,
    "patientId" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "ip" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intake_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_notes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "kind" "AppointmentNoteKind" NOT NULL DEFAULT 'DICTATION',
    "body" TEXT NOT NULL,
    "language" TEXT,
    "durationSeconds" INTEGER,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,

    CONSTRAINT "appointment_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_views" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_snapshots" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "source" "ReviewSource" NOT NULL DEFAULT 'MANUAL',
    "weekStart" DATE NOT NULL,
    "count" INTEGER NOT NULL,
    "rating" DOUBLE PRECISION NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_blobs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_blobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "treatments_tenantId_idx" ON "treatments"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "treatments_tenantId_key_key" ON "treatments"("tenantId", "key");

-- CreateIndex
CREATE INDEX "campaigns_tenantId_idx" ON "campaigns"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_tenantId_externalId_key" ON "campaigns"("tenantId", "externalId");

-- CreateIndex
CREATE INDEX "campaign_costs_tenantId_campaignId_periodStart_idx" ON "campaign_costs"("tenantId", "campaignId", "periodStart");

-- CreateIndex
CREATE INDEX "leads_tenantId_stage_idx" ON "leads"("tenantId", "stage");

-- CreateIndex
CREATE INDEX "leads_tenantId_createdAt_idx" ON "leads"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "leads_tenantId_phone_idx" ON "leads"("tenantId", "phone");

-- CreateIndex
CREATE INDEX "leads_tenantId_campaignId_idx" ON "leads"("tenantId", "campaignId");

-- CreateIndex
CREATE INDEX "leads_tenantId_ownerId_idx" ON "leads"("tenantId", "ownerId");

-- CreateIndex
CREATE INDEX "lead_follow_ups_tenantId_dueAt_idx" ON "lead_follow_ups"("tenantId", "dueAt");

-- CreateIndex
CREATE INDEX "lead_follow_ups_tenantId_ownerId_doneAt_idx" ON "lead_follow_ups"("tenantId", "ownerId", "doneAt");

-- CreateIndex
CREATE INDEX "lead_follow_ups_leadId_idx" ON "lead_follow_ups"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_tenantId_key_key" ON "message_templates"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "channel_integrations_tenantId_channel_key" ON "channel_integrations"("tenantId", "channel");

-- CreateIndex
CREATE INDEX "procedures_tenantId_performedAt_idx" ON "procedures"("tenantId", "performedAt");

-- CreateIndex
CREATE INDEX "procedures_tenantId_patientId_idx" ON "procedures"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "procedures_tenantId_doctorId_idx" ON "procedures"("tenantId", "doctorId");

-- CreateIndex
CREATE INDEX "procedures_tenantId_treatmentId_idx" ON "procedures"("tenantId", "treatmentId");

-- CreateIndex
CREATE INDEX "procedures_tenantId_status_idx" ON "procedures"("tenantId", "status");

-- CreateIndex
CREATE INDEX "payments_tenantId_paidAt_idx" ON "payments"("tenantId", "paidAt");

-- CreateIndex
CREATE INDEX "payments_tenantId_patientId_idx" ON "payments"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "payments_tenantId_appointmentId_idx" ON "payments"("tenantId", "appointmentId");

-- CreateIndex
CREATE INDEX "payments_procedureId_idx" ON "payments"("procedureId");

-- CreateIndex
CREATE INDEX "protocols_tenantId_status_idx" ON "protocols"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "protocols_tenantId_treatmentId_version_key" ON "protocols"("tenantId", "treatmentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "concierge_enrolments_procedureId_key" ON "concierge_enrolments"("procedureId");

-- CreateIndex
CREATE INDEX "concierge_enrolments_tenantId_status_idx" ON "concierge_enrolments"("tenantId", "status");

-- CreateIndex
CREATE INDEX "concierge_enrolments_tenantId_patientId_idx" ON "concierge_enrolments"("tenantId", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "concierge_tasks_tokenHash_key" ON "concierge_tasks"("tokenHash");

-- CreateIndex
CREATE INDEX "concierge_tasks_tenantId_status_dueAt_idx" ON "concierge_tasks"("tenantId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "concierge_tasks_enrolmentId_stepIndex_idx" ON "concierge_tasks"("enrolmentId", "stepIndex");

-- CreateIndex
CREATE UNIQUE INDEX "check_ins_taskId_key" ON "check_ins"("taskId");

-- CreateIndex
CREATE INDEX "check_ins_tenantId_submittedAt_idx" ON "check_ins"("tenantId", "submittedAt");

-- CreateIndex
CREATE INDEX "check_ins_tenantId_patientId_idx" ON "check_ins"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "escalations_tenantId_status_dueAt_idx" ON "escalations"("tenantId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "escalations_tenantId_assignedToId_status_idx" ON "escalations"("tenantId", "assignedToId", "status");

-- CreateIndex
CREATE INDEX "notifications_tenantId_userId_readAt_createdAt_idx" ON "notifications"("tenantId", "userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_tenantId_createdAt_idx" ON "notifications"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_userId_key" ON "notification_preferences"("userId");

-- CreateIndex
CREATE INDEX "notification_preferences_tenantId_idx" ON "notification_preferences"("tenantId");

-- CreateIndex
CREATE INDEX "alert_rules_tenantId_enabled_idx" ON "alert_rules"("tenantId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "metric_targets_tenantId_metric_key" ON "metric_targets"("tenantId", "metric");

-- CreateIndex
CREATE UNIQUE INDEX "intake_links_tokenHash_key" ON "intake_links"("tokenHash");

-- CreateIndex
CREATE INDEX "intake_links_tenantId_createdAt_idx" ON "intake_links"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "intake_links_tenantId_patientId_idx" ON "intake_links"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "intake_submissions_tenantId_status_submittedAt_idx" ON "intake_submissions"("tenantId", "status", "submittedAt");

-- CreateIndex
CREATE INDEX "appointment_notes_tenantId_appointmentId_idx" ON "appointment_notes"("tenantId", "appointmentId");

-- CreateIndex
CREATE INDEX "appointment_notes_tenantId_patientId_idx" ON "appointment_notes"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "saved_views_tenantId_userId_scope_idx" ON "saved_views"("tenantId", "userId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "review_snapshots_tenantId_source_weekStart_key" ON "review_snapshots"("tenantId", "source", "weekStart");

-- CreateIndex
CREATE INDEX "file_blobs_tenantId_patientId_idx" ON "file_blobs"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "appointments_tenantId_kind_idx" ON "appointments"("tenantId", "kind");

-- CreateIndex
CREATE INDEX "conversations_tenantId_status_updatedAt_idx" ON "conversations"("tenantId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "conversations_tenantId_leadId_idx" ON "conversations"("tenantId", "leadId");

-- CreateIndex
CREATE INDEX "patients_tenantId_nationalId_idx" ON "patients"("tenantId", "nationalId");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treatments" ADD CONSTRAINT "treatments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_treatmentId_fkey" FOREIGN KEY ("treatmentId") REFERENCES "treatments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_costs" ADD CONSTRAINT "campaign_costs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_costs" ADD CONSTRAINT "campaign_costs_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_follow_ups" ADD CONSTRAINT "lead_follow_ups_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_follow_ups" ADD CONSTRAINT "lead_follow_ups_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_integrations" ADD CONSTRAINT "channel_integrations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procedures" ADD CONSTRAINT "procedures_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procedures" ADD CONSTRAINT "procedures_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procedures" ADD CONSTRAINT "procedures_treatmentId_fkey" FOREIGN KEY ("treatmentId") REFERENCES "treatments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "procedures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protocols" ADD CONSTRAINT "protocols_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protocols" ADD CONSTRAINT "protocols_treatmentId_fkey" FOREIGN KEY ("treatmentId") REFERENCES "treatments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_enrolments" ADD CONSTRAINT "concierge_enrolments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_enrolments" ADD CONSTRAINT "concierge_enrolments_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_enrolments" ADD CONSTRAINT "concierge_enrolments_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "procedures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_enrolments" ADD CONSTRAINT "concierge_enrolments_protocolId_fkey" FOREIGN KEY ("protocolId") REFERENCES "protocols"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_tasks" ADD CONSTRAINT "concierge_tasks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_tasks" ADD CONSTRAINT "concierge_tasks_enrolmentId_fkey" FOREIGN KEY ("enrolmentId") REFERENCES "concierge_enrolments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_enrolmentId_fkey" FOREIGN KEY ("enrolmentId") REFERENCES "concierge_enrolments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "concierge_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_enrolmentId_fkey" FOREIGN KEY ("enrolmentId") REFERENCES "concierge_enrolments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_checkInId_fkey" FOREIGN KEY ("checkInId") REFERENCES "check_ins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_targets" ADD CONSTRAINT "metric_targets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_links" ADD CONSTRAINT "intake_links_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_links" ADD CONSTRAINT "intake_links_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_submissions" ADD CONSTRAINT "intake_submissions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_submissions" ADD CONSTRAINT "intake_submissions_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "intake_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_notes" ADD CONSTRAINT "appointment_notes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_notes" ADD CONSTRAINT "appointment_notes_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_notes" ADD CONSTRAINT "appointment_notes_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_snapshots" ADD CONSTRAINT "review_snapshots_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_blobs" ADD CONSTRAINT "file_blobs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── What Prisma cannot express ────────────────────────────────────────────────

-- Row-Level Security on the new tenant-scoped tables (same policy as the first migration).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'treatments', 'campaigns', 'campaign_costs', 'leads', 'lead_follow_ups',
    'message_templates', 'channel_integrations', 'procedures', 'payments',
    'protocols', 'concierge_enrolments', 'concierge_tasks', 'check_ins',
    'escalations', 'notifications', 'notification_preferences', 'alert_rules',
    'metric_targets', 'intake_links', 'intake_submissions', 'appointment_notes',
    'saved_views', 'review_snapshots', 'file_blobs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = app_current_tenant()) WITH CHECK ("tenantId" = app_current_tenant())',
      t
    );
  END LOOP;
END $$;

-- No double bookings, enforced by the database itself: a doctor never holds two
-- overlapping live appointments, and neither does a room. Cancelled, no-show
-- and waitlisted bookings do not occupy their slot. The application checks
-- first (advisory locks + conflict query) so users get a readable 409; this is
-- the guarantee underneath it. On a database that already holds overlapping
-- bookings the constraint is skipped with a notice; resolve them and run the
-- ALTER TABLE statements by hand.
CREATE EXTENSION IF NOT EXISTS "btree_gist";

DO $$
BEGIN
  ALTER TABLE "appointments" ADD CONSTRAINT "appointments_doctor_no_overlap"
    EXCLUDE USING gist ("doctorId" WITH =, tsrange("startsAt", "endsAt", '[)') WITH &&)
    WHERE ("doctorId" IS NOT NULL AND "deletedAt" IS NULL AND status NOT IN ('CANCELLED', 'NO_SHOW', 'WAITLISTED'));
EXCEPTION WHEN exclusion_violation THEN
  RAISE NOTICE 'appointments_doctor_no_overlap skipped: existing overlapping appointments for one doctor';
END $$;

DO $$
BEGIN
  ALTER TABLE "appointments" ADD CONSTRAINT "appointments_room_no_overlap"
    EXCLUDE USING gist ("tenantId" WITH =, "room" WITH =, tsrange("startsAt", "endsAt", '[)') WITH &&)
    WHERE ("room" IS NOT NULL AND "deletedAt" IS NULL AND status NOT IN ('CANCELLED', 'NO_SHOW', 'WAITLISTED'));
EXCEPTION WHEN exclusion_violation THEN
  RAISE NOTICE 'appointments_room_no_overlap skipped: existing overlapping appointments in one room';
END $$;

-- Trigram search on lead names and phone numbers for the CRM.
CREATE INDEX IF NOT EXISTS "leads_fullName_trgm_idx" ON "leads" USING gin ("fullName" gin_trgm_ops);
