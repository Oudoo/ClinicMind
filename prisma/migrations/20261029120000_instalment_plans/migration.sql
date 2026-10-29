-- Phase 5 (finance): instalment plans. A patient pays for treatment over time:
-- a down payment and instalments on set days (an implant, braces, a hair
-- transplant, a laser course). Payments recorded towards the plan cover its
-- instalments in order; the patient is reminded on WhatsApp before each one
-- is due and once when one is late, and the desk has the overdue list. The
-- schedule never changes once made (cancel the plan and make another).

-- CreateEnum
CREATE TYPE "InstalmentPlanStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'INSTALMENT_OVERDUE';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "instalmentPlanId" TEXT;

-- CreateTable
CREATE TABLE "instalment_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "quoteId" TEXT,
    "title" TEXT NOT NULL,
    "total" INTEGER NOT NULL,
    "downPayment" INTEGER NOT NULL DEFAULT 0,
    "everyMonths" INTEGER NOT NULL DEFAULT 1,
    "reminderDays" INTEGER NOT NULL DEFAULT 3,
    "status" "InstalmentPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

CONSTRAINT "instalment_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instalments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "amount" INTEGER NOT NULL,
    "paidAt" TIMESTAMP(3),
    "remindedAt" TIMESTAMP(3),
    "overdueRemindedAt" TIMESTAMP(3),

CONSTRAINT "instalments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "instalment_plans_tenantId_status_idx" ON "instalment_plans"("tenantId", "status");

-- CreateIndex
CREATE INDEX "instalment_plans_tenantId_patientId_idx" ON "instalment_plans"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "instalments_tenantId_dueAt_idx" ON "instalments"("tenantId", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "instalments_planId_number_key" ON "instalments"("planId", "number");

-- CreateIndex
CREATE INDEX "payments_instalmentPlanId_idx" ON "payments"("instalmentPlanId");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_instalmentPlanId_fkey" FOREIGN KEY ("instalmentPlanId") REFERENCES "instalment_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instalment_plans" ADD CONSTRAINT "instalment_plans_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instalment_plans" ADD CONSTRAINT "instalment_plans_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instalment_plans" ADD CONSTRAINT "instalment_plans_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instalments" ADD CONSTRAINT "instalments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instalments" ADD CONSTRAINT "instalments_planId_fkey" FOREIGN KEY ("planId") REFERENCES "instalment_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What a plan can be.
ALTER TABLE "instalment_plans" ADD CONSTRAINT "instalment_plans_amounts" CHECK ("total" > 0 AND "downPayment" >= 0 AND "downPayment" < "total");
ALTER TABLE "instalment_plans" ADD CONSTRAINT "instalment_plans_terms" CHECK ("everyMonths" BETWEEN 1 AND 12 AND "reminderDays" BETWEEN 0 AND 14);
ALTER TABLE "instalment_plans" ADD CONSTRAINT "instalment_plans_completed" CHECK (("status" = 'COMPLETED') = ("completedAt" IS NOT NULL));
ALTER TABLE "instalment_plans" ADD CONSTRAINT "instalment_plans_cancelled" CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL) AND ("cancelledAt" IS NULL OR "cancelReason" IS NOT NULL));
ALTER TABLE "instalments" ADD CONSTRAINT "instalments_amounts" CHECK ("amount" > 0 AND "number" >= 0);

-- Row-level security, as on every clinic table (src/lib/db.ts).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['instalment_plans', 'instalments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = app_current_tenant()) WITH CHECK ("tenantId" = app_current_tenant())', t);
  END LOOP;
END $$;

-- A plan is never deleted (it is cancelled with a reason), and its schedule
-- never changes: an instalment's plan, number, day and amount stay as made;
-- only whether it is paid and reminded moves. Everything is allowed under
-- the audit log's opt-in, set when a whole tenant is removed and its rows
-- cascade.
CREATE OR REPLACE FUNCTION instalment_plans_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'an instalment plan is never deleted: cancel it with a reason'
    USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS instalment_plans_guard ON "instalment_plans";
CREATE TRIGGER instalment_plans_guard
  BEFORE DELETE ON "instalment_plans"
  FOR EACH ROW EXECUTE FUNCTION instalment_plans_guard();

CREATE OR REPLACE FUNCTION instalments_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an instalment is never deleted: cancel its plan'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW."tenantId", NEW."planId", NEW.number, NEW."dueAt", NEW.amount) IS DISTINCT FROM (OLD."tenantId", OLD."planId", OLD.number, OLD."dueAt", OLD.amount) THEN
    RAISE EXCEPTION 'the schedule of an instalment plan never changes'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS instalments_guard ON "instalments";
CREATE TRIGGER instalments_guard
  BEFORE UPDATE OR DELETE ON "instalments"
  FOR EACH ROW EXECUTE FUNCTION instalments_guard();
