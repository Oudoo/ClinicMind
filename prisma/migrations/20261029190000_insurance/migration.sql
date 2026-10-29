-- Phase 5F: insurance and companies.

-- CreateEnum
CREATE TYPE "PayerKind" AS ENUM ('INSURER', 'COMPANY');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REFUSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('OPEN', 'SENT', 'SETTLED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "TimelineKind" ADD VALUE 'INSURANCE';

-- CreateTable
CREATE TABLE "payers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PayerKind" NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "paymentDays" INTEGER NOT NULL DEFAULT 60,
    "notes" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payer_contracts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "payerId" TEXT NOT NULL,
    "reference" TEXT,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "discountPct" INTEGER NOT NULL DEFAULT 0,
    "copayPct" INTEGER NOT NULL DEFAULT 0,
    "annualLimit" INTEGER,
    "approvalAbove" INTEGER,
    "coveredByDefault" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payer_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payer_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "category" TEXT,
    "priceItemId" TEXT,
    "covered" BOOLEAN NOT NULL,
    "copayPct" INTEGER,
    "needsApproval" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "payer_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coverages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "payerId" TEXT NOT NULL,
    "memberNumber" TEXT NOT NULL,
    "plan" TEXT,
    "employer" TEXT,
    "relation" TEXT NOT NULL DEFAULT 'SELF',
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "endReason" TEXT,
    "endedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coverages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pre_approvals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "coverageId" TEXT NOT NULL,
    "payerId" TEXT NOT NULL,
    "procedureId" TEXT,
    "description" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "requestedById" TEXT,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'REQUESTED',
    "approvalNumber" TEXT,
    "approvedAmount" INTEGER,
    "validUntil" DATE,
    "refusalReason" TEXT,
    "answeredAt" TIMESTAMP(3),
    "answeredById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pre_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claims" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "payerId" TEXT NOT NULL,
    "coverageId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "number" TEXT NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'OPEN',
    "amount" INTEGER NOT NULL,
    "patientShare" INTEGER NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL,
    "batchId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "procedureId" TEXT,
    "contractId" TEXT NOT NULL,
    "approvalId" TEXT,
    "description" TEXT NOT NULL,
    "workedAt" TIMESTAMP(3) NOT NULL,
    "amount" INTEGER NOT NULL,
    "contractDiscount" INTEGER NOT NULL DEFAULT 0,
    "patientShare" INTEGER NOT NULL,
    "payerShare" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "claim_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_batches" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "payerId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "number" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "sentById" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payer_payments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "payerId" TEXT NOT NULL,
    "batchId" TEXT,
    "amount" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'BANK_TRANSFER',
    "paidAt" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payer_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_answers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "claimLineId" TEXT NOT NULL,
    "payerPaymentId" TEXT NOT NULL,
    "paid" INTEGER NOT NULL DEFAULT 0,
    "refused" INTEGER NOT NULL DEFAULT 0,
    "refusalReason" TEXT,
    "writeOffId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_answers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payers_tenantId_idx" ON "payers"("tenantId");

-- CreateIndex
CREATE INDEX "payer_contracts_tenantId_payerId_validFrom_idx" ON "payer_contracts"("tenantId", "payerId", "validFrom");

-- CreateIndex
CREATE INDEX "payer_rules_tenantId_contractId_idx" ON "payer_rules"("tenantId", "contractId");

-- CreateIndex
CREATE INDEX "coverages_tenantId_patientId_idx" ON "coverages"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "coverages_tenantId_payerId_idx" ON "coverages"("tenantId", "payerId");

-- CreateIndex
CREATE INDEX "pre_approvals_tenantId_status_idx" ON "pre_approvals"("tenantId", "status");

-- CreateIndex
CREATE INDEX "pre_approvals_tenantId_patientId_idx" ON "pre_approvals"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "claims_tenantId_payerId_status_idx" ON "claims"("tenantId", "payerId", "status");

-- CreateIndex
CREATE INDEX "claims_tenantId_patientId_idx" ON "claims"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "claims_batchId_idx" ON "claims"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "claims_tenantId_clinicId_sequence_key" ON "claims"("tenantId", "clinicId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "claims_tenantId_number_key" ON "claims"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "claims_invoiceId_coverageId_key" ON "claims"("invoiceId", "coverageId");

-- CreateIndex
CREATE INDEX "claim_lines_tenantId_claimId_idx" ON "claim_lines"("tenantId", "claimId");

-- CreateIndex
CREATE INDEX "claim_lines_chargeId_idx" ON "claim_lines"("chargeId");

-- CreateIndex
CREATE INDEX "claim_lines_approvalId_idx" ON "claim_lines"("approvalId");

-- CreateIndex
CREATE INDEX "claim_batches_tenantId_payerId_idx" ON "claim_batches"("tenantId", "payerId");

-- CreateIndex
CREATE UNIQUE INDEX "claim_batches_tenantId_clinicId_sequence_key" ON "claim_batches"("tenantId", "clinicId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "claim_batches_tenantId_number_key" ON "claim_batches"("tenantId", "number");

-- CreateIndex
CREATE INDEX "payer_payments_tenantId_payerId_paidAt_idx" ON "payer_payments"("tenantId", "payerId", "paidAt");

-- CreateIndex
CREATE INDEX "payer_payments_tenantId_paidAt_idx" ON "payer_payments"("tenantId", "paidAt");

-- CreateIndex
CREATE UNIQUE INDEX "claim_answers_writeOffId_key" ON "claim_answers"("writeOffId");

-- CreateIndex
CREATE INDEX "claim_answers_tenantId_claimLineId_idx" ON "claim_answers"("tenantId", "claimLineId");

-- CreateIndex
CREATE INDEX "claim_answers_payerPaymentId_idx" ON "claim_answers"("payerPaymentId");

-- AddForeignKey
ALTER TABLE "payers" ADD CONSTRAINT "payers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payer_contracts" ADD CONSTRAINT "payer_contracts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payer_contracts" ADD CONSTRAINT "payer_contracts_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "payers"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payer_rules" ADD CONSTRAINT "payer_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payer_rules" ADD CONSTRAINT "payer_rules_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "payer_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payer_rules" ADD CONSTRAINT "payer_rules_priceItemId_fkey" FOREIGN KEY ("priceItemId") REFERENCES "price_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coverages" ADD CONSTRAINT "coverages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coverages" ADD CONSTRAINT "coverages_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coverages" ADD CONSTRAINT "coverages_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "payers"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_approvals" ADD CONSTRAINT "pre_approvals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_approvals" ADD CONSTRAINT "pre_approvals_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_approvals" ADD CONSTRAINT "pre_approvals_coverageId_fkey" FOREIGN KEY ("coverageId") REFERENCES "coverages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_approvals" ADD CONSTRAINT "pre_approvals_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "payers"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_approvals" ADD CONSTRAINT "pre_approvals_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "procedures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "payers"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_coverageId_fkey" FOREIGN KEY ("coverageId") REFERENCES "coverages"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "claim_batches"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_lines" ADD CONSTRAINT "claim_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_lines" ADD CONSTRAINT "claim_lines_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_lines" ADD CONSTRAINT "claim_lines_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "charges"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_lines" ADD CONSTRAINT "claim_lines_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "payer_contracts"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_lines" ADD CONSTRAINT "claim_lines_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "pre_approvals"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_batches" ADD CONSTRAINT "claim_batches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_batches" ADD CONSTRAINT "claim_batches_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_batches" ADD CONSTRAINT "claim_batches_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "payers"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payer_payments" ADD CONSTRAINT "payer_payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payer_payments" ADD CONSTRAINT "payer_payments_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "payers"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payer_payments" ADD CONSTRAINT "payer_payments_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "claim_batches"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_answers" ADD CONSTRAINT "claim_answers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_answers" ADD CONSTRAINT "claim_answers_claimLineId_fkey" FOREIGN KEY ("claimLineId") REFERENCES "claim_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_answers" ADD CONSTRAINT "claim_answers_payerPaymentId_fkey" FOREIGN KEY ("payerPaymentId") REFERENCES "payer_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_answers" ADD CONSTRAINT "claim_answers_writeOffId_fkey" FOREIGN KEY ("writeOffId") REFERENCES "write_offs"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- What each row can be.
ALTER TABLE "payers" ADD CONSTRAINT "payers_name" CHECK (length(btrim("name")) BETWEEN 2 AND 120);
ALTER TABLE "payers" ADD CONSTRAINT "payers_payment_days" CHECK ("paymentDays" BETWEEN 0 AND 365);
CREATE UNIQUE INDEX "payers_tenantId_name_key" ON "payers" ("tenantId", lower(btrim("name")));
ALTER TABLE "payer_contracts" ADD CONSTRAINT "payer_contracts_terms" CHECK (
  "discountPct" BETWEEN 0 AND 90 AND "copayPct" BETWEEN 0 AND 100
  AND ("annualLimit" IS NULL OR "annualLimit" > 0) AND ("approvalAbove" IS NULL OR "approvalAbove" >= 0)
  AND ("validTo" IS NULL OR "validTo" >= "validFrom"));
ALTER TABLE "payer_rules" ADD CONSTRAINT "payer_rules_scope" CHECK (("category" IS NULL) <> ("priceItemId" IS NULL));
ALTER TABLE "payer_rules" ADD CONSTRAINT "payer_rules_copay" CHECK ("copayPct" IS NULL OR "copayPct" BETWEEN 0 AND 100);
CREATE UNIQUE INDEX "payer_rules_contract_category_key" ON "payer_rules" ("contractId", "category") WHERE "category" IS NOT NULL;
CREATE UNIQUE INDEX "payer_rules_contract_item_key" ON "payer_rules" ("contractId", "priceItemId") WHERE "priceItemId" IS NOT NULL;
ALTER TABLE "coverages" ADD CONSTRAINT "coverages_card" CHECK (
  length(btrim("memberNumber")) BETWEEN 1 AND 60
  AND "relation" IN ('SELF', 'SPOUSE', 'CHILD', 'PARENT', 'OTHER')
  AND ("validTo" IS NULL OR "validTo" >= "validFrom")
  AND ("endReason" IS NULL OR "validTo" IS NOT NULL));
ALTER TABLE "pre_approvals" ADD CONSTRAINT "pre_approvals_answer" CHECK (
  "amount" > 0
  AND ("status" <> 'APPROVED' OR ("approvedAmount" IS NOT NULL AND "approvalNumber" IS NOT NULL))
  AND ("approvedAmount" IS NULL OR "approvedAmount" > 0)
  AND ("status" <> 'REFUSED' OR "refusalReason" IS NOT NULL)
  AND (("status" = 'REQUESTED') = ("answeredAt" IS NULL)));
ALTER TABLE "claims" ADD CONSTRAINT "claims_amounts" CHECK ("amount" > 0 AND "patientShare" >= 0);
ALTER TABLE "claims" ADD CONSTRAINT "claims_cancelled" CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL) AND ("cancelledAt" IS NULL) = ("cancelReason" IS NULL));
ALTER TABLE "claim_lines" ADD CONSTRAINT "claim_lines_shares" CHECK (
  "amount" > 0 AND "payerShare" > 0 AND "patientShare" >= 0 AND "contractDiscount" >= 0
  AND "payerShare" + "patientShare" = "amount");
ALTER TABLE "payer_payments" ADD CONSTRAINT "payer_payments_amount" CHECK ("amount" >= 0);
ALTER TABLE "payer_payments" ADD CONSTRAINT "payer_payments_voided" CHECK (("voidedAt" IS NULL) = ("voidReason" IS NULL));
ALTER TABLE "claim_answers" ADD CONSTRAINT "claim_answers_amounts" CHECK (
  "paid" >= 0 AND "refused" >= 0 AND "paid" + "refused" > 0
  AND (("refused" > 0) = ("refusalReason" IS NOT NULL))
  AND ("writeOffId" IS NULL OR "refused" > 0));

-- Row-level security, as on every clinic table (src/lib/db.ts).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payers', 'payer_contracts', 'payer_rules', 'coverages', 'pre_approvals', 'claims', 'claim_lines', 'claim_batches', 'payer_payments', 'claim_answers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = app_current_tenant()) WITH CHECK ("tenantId" = app_current_tenant())', t);
  END LOOP;
END $$;

-- A claim is never deleted: it is cancelled with its invoice. It keeps its invoice, its patient, its payer, its
-- number and its amounts; once in a batch it stays there, and once cancelled it never changes. Its lines never
-- change. Everything is allowed under the audit log's opt-in, set when a whole tenant is removed.
CREATE OR REPLACE FUNCTION claims_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a claim is never deleted: it is cancelled with its invoice'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'CANCELLED'
     OR (NEW."tenantId", NEW."clinicId", NEW."payerId", NEW."coverageId", NEW."patientId", NEW."invoiceId", NEW.sequence, NEW.number, NEW.amount, NEW."patientShare", NEW."claimedAt", NEW."createdAt")
        IS DISTINCT FROM (OLD."tenantId", OLD."clinicId", OLD."payerId", OLD."coverageId", OLD."patientId", OLD."invoiceId", OLD.sequence, OLD.number, OLD.amount, OLD."patientShare", OLD."claimedAt", OLD."createdAt")
     OR (OLD."batchId" IS NOT NULL AND NEW."batchId" IS DISTINCT FROM OLD."batchId") THEN
    RAISE EXCEPTION 'a claim keeps its invoice, its payer, its number and its amounts, and stays in its batch; cancelled, it never changes'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS claims_guard ON "claims";
CREATE TRIGGER claims_guard
  BEFORE UPDATE OR DELETE ON "claims"
  FOR EACH ROW EXECUTE FUNCTION claims_guard();

-- A claim's lines never change once written.
CREATE OR REPLACE FUNCTION claim_lines_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'a claim''s lines never change and are never deleted'
    USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS claim_lines_guard ON "claim_lines";
CREATE TRIGGER claim_lines_guard
  BEFORE UPDATE OR DELETE ON "claim_lines"
  FOR EACH ROW EXECUTE FUNCTION claim_lines_guard();

-- A batch is fixed once sent: only the payer's reference and the note change.
CREATE OR REPLACE FUNCTION claim_batches_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW."tenantId", NEW."clinicId", NEW."payerId", NEW.sequence, NEW.number, NEW."sentAt", NEW."sentById", NEW."createdAt")
         IS NOT DISTINCT FROM (OLD."tenantId", OLD."clinicId", OLD."payerId", OLD.sequence, OLD.number, OLD."sentAt", OLD."sentById", OLD."createdAt") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a batch of claims is fixed once sent and never deleted'
    USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS claim_batches_guard ON "claim_batches";
CREATE TRIGGER claim_batches_guard
  BEFORE UPDATE OR DELETE ON "claim_batches"
  FOR EACH ROW EXECUTE FUNCTION claim_batches_guard();

-- The payer's money and its answers are never deleted or changed: they are voided once, with the reason.
CREATE OR REPLACE FUNCTION payer_payments_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."voidedAt" IS NULL AND NEW."voidedAt" IS NOT NULL
     AND (NEW."tenantId", NEW."payerId", NEW."batchId", NEW.amount, NEW.method, NEW."paidAt", NEW.reference, NEW."createdById", NEW."createdAt")
         IS NOT DISTINCT FROM (OLD."tenantId", OLD."payerId", OLD."batchId", OLD.amount, OLD.method, OLD."paidAt", OLD.reference, OLD."createdById", OLD."createdAt") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a payer''s payment is never deleted or changed: it is voided once, with the reason'
    USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS payer_payments_guard ON "payer_payments";
CREATE TRIGGER payer_payments_guard
  BEFORE UPDATE OR DELETE ON "payer_payments"
  FOR EACH ROW EXECUTE FUNCTION payer_payments_guard();

CREATE OR REPLACE FUNCTION claim_answers_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."voidedAt" IS NULL AND NEW."voidedAt" IS NOT NULL
     AND (NEW."tenantId", NEW."claimLineId", NEW."payerPaymentId", NEW.paid, NEW.refused, NEW."refusalReason", NEW."writeOffId", NEW."createdAt")
         IS NOT DISTINCT FROM (OLD."tenantId", OLD."claimLineId", OLD."payerPaymentId", OLD.paid, OLD.refused, OLD."refusalReason", OLD."writeOffId", OLD."createdAt") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a payer''s answer is never deleted or changed: it is voided once, with its payment'
    USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS claim_answers_guard ON "claim_answers";
CREATE TRIGGER claim_answers_guard
  BEFORE UPDATE OR DELETE ON "claim_answers"
  FOR EACH ROW EXECUTE FUNCTION claim_answers_guard();

-- An answer is the claim's payer's, and what a line is paid and refused never passes the payer's share of it.
CREATE OR REPLACE FUNCTION claim_answers_within() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  share integer;
  claim_payer text;
  answered integer;
BEGIN
  SELECT l."payerShare", c."payerId" INTO share, claim_payer
    FROM "claim_lines" l JOIN "claims" c ON c.id = l."claimId"
    WHERE l.id = NEW."claimLineId" FOR UPDATE OF l;
  IF claim_payer IS DISTINCT FROM (SELECT "payerId" FROM "payer_payments" WHERE id = NEW."payerPaymentId") THEN
    RAISE EXCEPTION 'a payer answers only its own claims'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(SUM(paid + refused), 0) INTO answered
    FROM "claim_answers" WHERE "claimLineId" = NEW."claimLineId" AND "voidedAt" IS NULL;
  IF answered + NEW.paid + NEW.refused > share THEN
    RAISE EXCEPTION 'a claim line is paid and refused no more than the payer''s share of it'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS claim_answers_within ON "claim_answers";
CREATE TRIGGER claim_answers_within
  BEFORE INSERT ON "claim_answers"
  FOR EACH ROW EXECUTE FUNCTION claim_answers_within();
