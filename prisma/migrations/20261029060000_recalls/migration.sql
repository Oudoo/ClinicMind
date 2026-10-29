-- Recalls: the rules that bring patients back (a course's next session, reviews after a treatment or a
-- diagnosis), the recalls themselves (one per source, never twice) and the log of every call, message and
-- change of state on them.

-- CreateEnum
CREATE TYPE "RecallKind" AS ENUM ('REVIEW', 'NEXT_SESSION', 'UNBOOKED', 'MISSED', 'LAPSED');

-- CreateEnum
CREATE TYPE "RecallStatus" AS ENUM ('OPEN', 'CONTACTED', 'SNOOZED', 'BOOKED', 'DONE', 'DECLINED', 'UNREACHABLE');

-- CreateEnum
CREATE TYPE "RecallActivityKind" AS ENUM ('CALL', 'MESSAGE', 'STATUS', 'NOTE');

-- CreateEnum
CREATE TYPE "RecallRuleKind" AS ENUM ('SESSIONS', 'REVIEWS');

-- CreateTable
CREATE TABLE "recall_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "RecallRuleKind" NOT NULL,
    "treatmentId" TEXT,
    "diagnosisTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dueDays" INTEGER[],
    "windowDays" INTEGER NOT NULL DEFAULT 14,
    "sessions" INTEGER,
    "ownerRole" "UserRole" NOT NULL DEFAULT 'RECEPTIONIST',
    "ownerId" TEXT,
    "channel" "ChannelType" NOT NULL DEFAULT 'WHATSAPP',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recall_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recalls" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "kind" "RecallKind" NOT NULL,
    "ruleId" TEXT,
    "treatmentId" TEXT,
    "procedureId" TEXT,
    "stage" INTEGER,
    "appointmentId" TEXT,
    "consultationId" TEXT,
    "label" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "windowEndAt" TIMESTAMP(3) NOT NULL,
    "status" "RecallStatus" NOT NULL DEFAULT 'OPEN',
    "ownerRole" "UserRole" NOT NULL DEFAULT 'RECEPTIONIST',
    "ownerId" TEXT,
    "channel" "ChannelType" NOT NULL DEFAULT 'WHATSAPP',
    "value" INTEGER NOT NULL DEFAULT 0,
    "nextContactAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastContactAt" TIMESTAMP(3),
    "snoozedUntil" TIMESTAMP(3),
    "bookedAppointmentId" TEXT,
    "bookedAt" TIMESTAMP(3),
    "bookedById" TEXT,
    "doneAppointmentId" TEXT,
    "declineReason" TEXT,
    "outcomeNote" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "autoStep" INTEGER NOT NULL DEFAULT 0,
    "dedupeKey" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recalls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recall_activities" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recallId" TEXT NOT NULL,
    "kind" "RecallActivityKind" NOT NULL,
    "outcome" TEXT,
    "note" TEXT,
    "messageId" TEXT,
    "byId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recall_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recall_rules_tenantId_treatmentId_idx" ON "recall_rules"("tenantId", "treatmentId");

-- CreateIndex
CREATE INDEX "recalls_tenantId_status_dueAt_idx" ON "recalls"("tenantId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "recalls_tenantId_patientId_status_idx" ON "recalls"("tenantId", "patientId", "status");

-- CreateIndex
CREATE INDEX "recalls_tenantId_bookedAppointmentId_idx" ON "recalls"("tenantId", "bookedAppointmentId");

-- CreateIndex
CREATE INDEX "recalls_procedureId_idx" ON "recalls"("procedureId");

-- CreateIndex
CREATE UNIQUE INDEX "recalls_tenantId_dedupeKey_key" ON "recalls"("tenantId", "dedupeKey");

-- CreateIndex
CREATE INDEX "recall_activities_tenantId_recallId_at_idx" ON "recall_activities"("tenantId", "recallId", "at");

-- CreateIndex
CREATE INDEX "recall_activities_tenantId_byId_at_idx" ON "recall_activities"("tenantId", "byId", "at");

-- AddForeignKey
ALTER TABLE "recall_rules" ADD CONSTRAINT "recall_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_rules" ADD CONSTRAINT "recall_rules_treatmentId_fkey" FOREIGN KEY ("treatmentId") REFERENCES "treatments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "recall_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_treatmentId_fkey" FOREIGN KEY ("treatmentId") REFERENCES "treatments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "procedures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_activities" ADD CONSTRAINT "recall_activities_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_activities" ADD CONSTRAINT "recall_activities_recallId_fkey" FOREIGN KEY ("recallId") REFERENCES "recalls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What a rule and a recall may hold.
ALTER TABLE "recall_rules" ADD CONSTRAINT "recall_rules_due_days" CHECK (cardinality("dueDays") BETWEEN 1 AND 12 AND 0 < ALL ("dueDays") AND 3660 >= ALL ("dueDays"));
ALTER TABLE "recall_rules" ADD CONSTRAINT "recall_rules_sessions_one_interval" CHECK ("kind" <> 'SESSIONS' OR cardinality("dueDays") = 1);
ALTER TABLE "recall_rules" ADD CONSTRAINT "recall_rules_window" CHECK ("windowDays" BETWEEN 0 AND 365);
ALTER TABLE "recall_rules" ADD CONSTRAINT "recall_rules_session_count" CHECK ("sessions" IS NULL OR "sessions" BETWEEN 2 AND 50);
ALTER TABLE "recall_rules" ADD CONSTRAINT "recall_rules_trigger" CHECK ("treatmentId" IS NOT NULL OR cardinality("diagnosisTerms") > 0);
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_window" CHECK ("windowEndAt" >= "dueAt");
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_counts" CHECK ("value" >= 0 AND "attempts" >= 0 AND "autoStep" BETWEEN 0 AND 3);
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_session_stage" CHECK ("kind" <> 'NEXT_SESSION' OR "stage" >= 1);
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_closed" CHECK (("status" IN ('DONE', 'DECLINED', 'UNREACHABLE')) = ("closedAt" IS NOT NULL));
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_declined_reason" CHECK ("status" <> 'DECLINED' OR "declineReason" IS NOT NULL);
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_booked_visit" CHECK ("status" <> 'BOOKED' OR "bookedAppointmentId" IS NOT NULL);
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_snoozed_until" CHECK ("status" <> 'SNOOZED' OR "snoozedUntil" IS NOT NULL);

-- Row-level security, as on every clinic table (src/lib/db.ts).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['recall_rules', 'recalls', 'recall_activities'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = app_current_tenant()) WITH CHECK ("tenantId" = app_current_tenant())', t);
  END LOOP;
END $$;

-- A recall is never deleted and its log is never edited or deleted: what reception did stays on the record.
-- The audit log's opt-in, set when a whole tenant is removed and its rows cascade, lets them go.
CREATE OR REPLACE FUNCTION recalls_keep() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_TABLE_NAME = 'recalls' THEN
    RAISE EXCEPTION 'recalls are never deleted: close them as done, declined or unreachable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RAISE EXCEPTION 'the recall log is never edited or deleted (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS recalls_no_delete ON "recalls";
CREATE TRIGGER recalls_no_delete
  BEFORE DELETE ON "recalls"
  FOR EACH ROW EXECUTE FUNCTION recalls_keep();

DROP TRIGGER IF EXISTS recall_activities_append_only ON "recall_activities";
CREATE TRIGGER recall_activities_append_only
  BEFORE UPDATE OR DELETE ON "recall_activities"
  FOR EACH ROW EXECUTE FUNCTION recalls_keep();
