-- Audit log: the patient each row concerns, so the owner's audit-log screen can
-- search by patient, plus an index for searching by person.
ALTER TABLE "audit_logs" ADD COLUMN "patientId" TEXT;

-- Backfill from what earlier rows already carry: the patient itself, a
-- patientId in the before/after snapshot, or the patient of the row the entry
-- names. The table is append-only (trigger audit_logs_no_update_delete refuses
-- every UPDATE), so the trigger is off for these statements only, inside this
-- migration's transaction.
ALTER TABLE "audit_logs" DISABLE TRIGGER audit_logs_no_update_delete;

UPDATE "audit_logs" SET "patientId" = COALESCE(
  CASE WHEN "entity" = 'Patient' THEN "entityId" END,
  NULLIF("after"->>'patientId', ''),
  NULLIF("before"->>'patientId', '')
)
WHERE "patientId" IS NULL;

UPDATE "audit_logs" a SET "patientId" = x."patientId" FROM "appointments" x
  WHERE a."patientId" IS NULL AND a."entity" = 'Appointment' AND a."entityId" = x."id";
UPDATE "audit_logs" a SET "patientId" = x."patientId" FROM "consultations" x
  WHERE a."patientId" IS NULL AND a."entity" = 'Consultation' AND a."entityId" = x."id";
UPDATE "audit_logs" a SET "patientId" = x."patientId" FROM "procedures" x
  WHERE a."patientId" IS NULL AND a."entity" = 'Procedure' AND a."entityId" = x."id";
UPDATE "audit_logs" a SET "patientId" = x."patientId" FROM "payments" x
  WHERE a."patientId" IS NULL AND a."entity" = 'Payment' AND a."entityId" = x."id";
UPDATE "audit_logs" a SET "patientId" = x."patientId" FROM "conversations" x
  WHERE a."patientId" IS NULL AND a."entity" = 'Conversation' AND a."entityId" = x."id";
UPDATE "audit_logs" a SET "patientId" = x."patientId" FROM "intake_submissions" x
  WHERE a."patientId" IS NULL AND a."entity" = 'IntakeSubmission' AND a."entityId" = x."id";
UPDATE "audit_logs" a SET "patientId" = x."patientId" FROM "concierge_enrolments" x
  WHERE a."patientId" IS NULL AND a."entity" = 'ConciergeEnrolment' AND a."entityId" = x."id";
UPDATE "audit_logs" a SET "patientId" = x."patientId" FROM "escalations" x
  WHERE a."patientId" IS NULL AND a."entity" = 'Escalation' AND a."entityId" = x."id";
UPDATE "audit_logs" a SET "patientId" = x."patientId" FROM "appointment_notes" x
  WHERE a."patientId" IS NULL AND a."entity" = 'AppointmentNote' AND a."entityId" = x."id";
UPDATE "audit_logs" a SET "patientId" = x."patientId" FROM "medical_histories" x
  WHERE a."patientId" IS NULL AND a."entity" = 'MedicalHistory' AND a."entityId" = x."id";
UPDATE "audit_logs" a SET "patientId" = x."patientId" FROM "leads" x
  WHERE a."patientId" IS NULL AND a."entity" = 'Lead' AND a."entityId" = x."id";
UPDATE "audit_logs" a SET "patientId" = e."patientId" FROM "concierge_tasks" t JOIN "concierge_enrolments" e ON e."id" = t."enrolmentId"
  WHERE a."patientId" IS NULL AND a."entity" = 'ConciergeTask' AND a."entityId" = t."id";

ALTER TABLE "audit_logs" ENABLE TRIGGER audit_logs_no_update_delete;

CREATE INDEX "audit_logs_tenantId_patientId_createdAt_idx" ON "audit_logs"("tenantId", "patientId", "createdAt");
CREATE INDEX "audit_logs_tenantId_actorId_createdAt_idx" ON "audit_logs"("tenantId", "actorId", "createdAt");
