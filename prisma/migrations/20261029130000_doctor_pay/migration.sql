-- Phase 5 (finance): doctor pay. Each doctor's pay per category of the price
-- list (and for consultation fees, and for everything else): a share of what
-- is billed or of what is collected for their work, or a fixed fee for each
-- session done; the lab's bills and the materials used come off first, and a
-- share is never below zero. A month's statement is closed by the owner (it
-- never changes afterwards, but to be marked paid) and lists what each piece
-- of work had earned by the month's end less what earlier statements paid.

-- CreateEnum
CREATE TYPE "PayBasis" AS ENUM ('BILLED', 'COLLECTED', 'FIXED');

-- CreateEnum
CREATE TYPE "ProcedureCostKind" AS ENUM ('LAB', 'MATERIAL');

-- CreateEnum
CREATE TYPE "DoctorStatementStatus" AS ENUM ('CLOSED', 'PAID');

-- AlterTable
ALTER TABLE "price_items" ADD COLUMN     "materialCost" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "doctor_pay_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '*',
    "basis" "PayBasis" NOT NULL,
    "rate" INTEGER,
    "amount" INTEGER,
    "deductCosts" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "doctor_pay_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "procedure_costs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "procedureId" TEXT NOT NULL,
    "kind" "ProcedureCostKind" NOT NULL,
    "description" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "incurredAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,

    CONSTRAINT "procedure_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_statements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "DoctorStatementStatus" NOT NULL DEFAULT 'CLOSED',
    "billed" INTEGER NOT NULL,
    "collected" INTEGER NOT NULL,
    "costs" INTEGER NOT NULL,
    "earned" INTEGER NOT NULL,
    "broughtForward" INTEGER NOT NULL DEFAULT 0,
    "payable" INTEGER NOT NULL,
    "carriedForward" INTEGER NOT NULL DEFAULT 0,
    "closedAt" TIMESTAMP(3) NOT NULL,
    "closedById" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "paidMethod" "PaymentMethod",
    "paidReference" TEXT,
    "note" TEXT,

    CONSTRAINT "doctor_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_statement_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "procedureId" TEXT,
    "feeId" TEXT,
    "patientId" TEXT NOT NULL,
    "patientName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "workAt" TIMESTAMP(3) NOT NULL,
    "basis" "PayBasis",
    "rate" INTEGER,
    "amount" INTEGER,
    "deductCosts" BOOLEAN NOT NULL DEFAULT false,
    "billedInMonth" INTEGER NOT NULL DEFAULT 0,
    "collectedInMonth" INTEGER NOT NULL DEFAULT 0,
    "costsInMonth" INTEGER NOT NULL DEFAULT 0,
    "billedToDate" INTEGER NOT NULL,
    "collectedToDate" INTEGER NOT NULL,
    "costsToDate" INTEGER NOT NULL,
    "sessionsToDate" INTEGER NOT NULL,
    "earnedToDate" INTEGER NOT NULL,
    "paidBefore" INTEGER NOT NULL,
    "due" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "doctor_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "doctor_pay_rules_tenantId_doctorId_idx" ON "doctor_pay_rules"("tenantId", "doctorId");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_pay_rules_tenantId_doctorId_category_key" ON "doctor_pay_rules"("tenantId", "doctorId", "category");

-- CreateIndex
CREATE INDEX "procedure_costs_tenantId_procedureId_idx" ON "procedure_costs"("tenantId", "procedureId");

-- CreateIndex
CREATE INDEX "doctor_statements_tenantId_month_idx" ON "doctor_statements"("tenantId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_statements_tenantId_doctorId_month_key" ON "doctor_statements"("tenantId", "doctorId", "month");

-- CreateIndex
CREATE INDEX "doctor_statement_lines_tenantId_statementId_idx" ON "doctor_statement_lines"("tenantId", "statementId");

-- CreateIndex
CREATE INDEX "doctor_statement_lines_tenantId_procedureId_idx" ON "doctor_statement_lines"("tenantId", "procedureId");

-- CreateIndex
CREATE INDEX "doctor_statement_lines_tenantId_feeId_idx" ON "doctor_statement_lines"("tenantId", "feeId");

-- AddForeignKey
ALTER TABLE "doctor_pay_rules" ADD CONSTRAINT "doctor_pay_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_pay_rules" ADD CONSTRAINT "doctor_pay_rules_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procedure_costs" ADD CONSTRAINT "procedure_costs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procedure_costs" ADD CONSTRAINT "procedure_costs_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "procedures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_statements" ADD CONSTRAINT "doctor_statements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_statements" ADD CONSTRAINT "doctor_statements_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_statement_lines" ADD CONSTRAINT "doctor_statement_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_statement_lines" ADD CONSTRAINT "doctor_statement_lines_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "doctor_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What each row can be.
ALTER TABLE "doctor_pay_rules" ADD CONSTRAINT "doctor_pay_rules_category" CHECK (length("category") BETWEEN 1 AND 40);
ALTER TABLE "doctor_pay_rules" ADD CONSTRAINT "doctor_pay_rules_terms" CHECK (
  ("basis" = 'FIXED' AND "amount" IS NOT NULL AND "amount" >= 0 AND "rate" IS NULL)
  OR ("basis" IN ('BILLED', 'COLLECTED') AND "rate" IS NOT NULL AND "rate" BETWEEN 0 AND 10000 AND "amount" IS NULL)
);
ALTER TABLE "price_items" ADD CONSTRAINT "price_items_material_cost" CHECK ("materialCost" >= 0);
ALTER TABLE "procedure_costs" ADD CONSTRAINT "procedure_costs_amount" CHECK ("amount" > 0);
ALTER TABLE "procedure_costs" ADD CONSTRAINT "procedure_costs_voided" CHECK (("voidedAt" IS NULL) = ("voidReason" IS NULL));
ALTER TABLE "doctor_statements" ADD CONSTRAINT "doctor_statements_month" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND "periodStart" < "periodEnd");
ALTER TABLE "doctor_statements" ADD CONSTRAINT "doctor_statements_sums" CHECK (
  "broughtForward" <= 0 AND "carriedForward" <= 0 AND "payable" >= 0
  AND "payable" + "carriedForward" = "earned" + "broughtForward"
  AND ("payable" = 0 OR "carriedForward" = 0)
);
ALTER TABLE "doctor_statements" ADD CONSTRAINT "doctor_statements_paid" CHECK (("status" = 'PAID') = ("paidAt" IS NOT NULL));
ALTER TABLE "doctor_statement_lines" ADD CONSTRAINT "doctor_statement_lines_work" CHECK (("procedureId" IS NULL) <> ("feeId" IS NULL));
ALTER TABLE "doctor_statement_lines" ADD CONSTRAINT "doctor_statement_lines_due" CHECK ("earnedToDate" >= 0 AND "due" = "earnedToDate" - "paidBefore");

-- Row-level security, as on every clinic table (src/lib/db.ts).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['doctor_pay_rules', 'procedure_costs', 'doctor_statements', 'doctor_statement_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = app_current_tenant()) WITH CHECK ("tenantId" = app_current_tenant())', t);
  END LOOP;
END $$;

-- A closed statement and its lines never change: the statement is only
-- marked paid (once), and nothing is deleted. A procedure's cost is never
-- deleted or changed: it is voided with a reason. Everything is allowed
-- under the audit log's opt-in, set when a whole tenant is removed.
CREATE OR REPLACE FUNCTION doctor_statements_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a closed doctor statement is never deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'CLOSED' OR NEW.status <> 'PAID'
     OR (NEW."tenantId", NEW."doctorId", NEW.month, NEW."periodStart", NEW."periodEnd", NEW.billed, NEW.collected, NEW.costs, NEW.earned, NEW."broughtForward", NEW.payable, NEW."carriedForward", NEW."closedAt", NEW."closedById")
        IS DISTINCT FROM (OLD."tenantId", OLD."doctorId", OLD.month, OLD."periodStart", OLD."periodEnd", OLD.billed, OLD.collected, OLD.costs, OLD.earned, OLD."broughtForward", OLD.payable, OLD."carriedForward", OLD."closedAt", OLD."closedById") THEN
    RAISE EXCEPTION 'a closed doctor statement never changes: it is only marked paid'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS doctor_statements_guard ON "doctor_statements";
CREATE TRIGGER doctor_statements_guard
  BEFORE UPDATE OR DELETE ON "doctor_statements"
  FOR EACH ROW EXECUTE FUNCTION doctor_statements_guard();

CREATE OR REPLACE FUNCTION doctor_statement_lines_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'the lines of a closed doctor statement never change'
    USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS doctor_statement_lines_guard ON "doctor_statement_lines";
CREATE TRIGGER doctor_statement_lines_guard
  BEFORE UPDATE OR DELETE ON "doctor_statement_lines"
  FOR EACH ROW EXECUTE FUNCTION doctor_statement_lines_guard();

CREATE OR REPLACE FUNCTION procedure_costs_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a procedure cost is never deleted: void it with a reason'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."voidedAt" IS NOT NULL
     OR (NEW."tenantId", NEW."procedureId", NEW.kind, NEW.description, NEW.amount, NEW."incurredAt", NEW."createdById", NEW."createdAt")
        IS DISTINCT FROM (OLD."tenantId", OLD."procedureId", OLD.kind, OLD.description, OLD.amount, OLD."incurredAt", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'a procedure cost never changes: void it with a reason'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS procedure_costs_guard ON "procedure_costs";
CREATE TRIGGER procedure_costs_guard
  BEFORE UPDATE OR DELETE ON "procedure_costs"
  FOR EACH ROW EXECUTE FUNCTION procedure_costs_guard();
