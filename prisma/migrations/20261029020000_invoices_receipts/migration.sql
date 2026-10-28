-- Phase 2 (finance): invoices and receipts. An invoice bills a patient for
-- charges of one branch; it is numbered when issued, from the branch's own
-- sequence taken in the issuing transaction (no gaps), and from then on is
-- never deleted, only cancelled with a reason and a numbered credit note.
-- Every payment gets a receipt number (a refund, a refund voucher number) the
-- same way. Payments are allocated to invoices; what is not allocated is the
-- patient's credit. New methods: InstaPay and cheque.

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PART_PAID', 'PAID', 'CANCELLED');

-- AlterEnum (PostgreSQL 12 and later add enum values inside a transaction)
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'INSTAPAY' BEFORE 'OTHER';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'CHEQUE' BEFORE 'OTHER';

-- AlterTable
ALTER TABLE "clinics" ADD COLUMN     "code" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "clinicId" TEXT,
ADD COLUMN     "receiptNumber" TEXT,
ADD COLUMN     "receiptSequence" INTEGER;

-- CreateTable
CREATE TABLE "document_sequences" (
    "tenantId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "document_sequences_pkey" PRIMARY KEY ("tenantId","clinicId","kind")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "sequence" INTEGER,
    "number" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "total" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "issuedAt" TIMESTAMP(3),
    "issuedById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "shareTokenHash" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "chargedAt" TIMESTAMP(3) NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_notes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "number" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "issuedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoices_shareTokenHash_key" ON "invoices"("shareTokenHash");

-- CreateIndex
CREATE INDEX "invoices_tenantId_patientId_idx" ON "invoices"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "invoices_tenantId_status_idx" ON "invoices"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_tenantId_clinicId_sequence_key" ON "invoices"("tenantId", "clinicId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_tenantId_number_key" ON "invoices"("tenantId", "number");

-- CreateIndex
CREATE INDEX "invoice_lines_tenantId_invoiceId_idx" ON "invoice_lines"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "invoice_lines_chargeId_idx" ON "invoice_lines"("chargeId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_invoiceId_key" ON "credit_notes"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_tenantId_clinicId_sequence_key" ON "credit_notes"("tenantId", "clinicId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_tenantId_number_key" ON "credit_notes"("tenantId", "number");

-- CreateIndex
CREATE INDEX "payment_allocations_tenantId_invoiceId_idx" ON "payment_allocations"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "payment_allocations_paymentId_idx" ON "payment_allocations"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "clinics_tenantId_code_key" ON "clinics"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenantId_receiptNumber_key" ON "payments"("tenantId", "receiptNumber");

-- AddForeignKey
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "charges"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security, as on every clinic table (src/lib/db.ts).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_sequences', 'invoices', 'invoice_lines', 'credit_notes', 'payment_allocations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = app_current_tenant()) WITH CHECK ("tenantId" = app_current_tenant())', t);
  END LOOP;
END $$;

-- An issued invoice keeps its number, branch, patient, total and lines; it is
-- never deleted (only a draft is). A credit note is never edited or deleted.
-- Deleting is allowed with the audit log's opt-in, set when a whole tenant is
-- removed and its rows cascade.
CREATE OR REPLACE FUNCTION invoices_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'DRAFT' OR current_setting('app.allow_audit_delete', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'an issued invoice is never deleted: cancel it with a credit note'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'DRAFT' AND (
       NEW.number IS DISTINCT FROM OLD.number OR NEW.sequence IS DISTINCT FROM OLD.sequence
    OR NEW."clinicId" IS DISTINCT FROM OLD."clinicId" OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
    OR NEW.total IS DISTINCT FROM OLD.total OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt"
    OR NEW.status = 'DRAFT') THEN
    RAISE EXCEPTION 'an issued invoice keeps its number, branch, patient and total'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS invoices_guard ON "invoices";
CREATE TRIGGER invoices_guard
  BEFORE UPDATE OR DELETE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION invoices_guard();

CREATE OR REPLACE FUNCTION invoice_lines_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  SELECT status::text INTO parent_status FROM "invoices" WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD."invoiceId" ELSE NEW."invoiceId" END;
  -- A draft's lines change freely; a draft being discarded takes its lines with it.
  IF parent_status IS NULL OR parent_status = 'DRAFT' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'the lines of an issued invoice never change'
    USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS invoice_lines_guard ON "invoice_lines";
CREATE TRIGGER invoice_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION invoice_lines_guard();

CREATE OR REPLACE FUNCTION credit_notes_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'credit notes are never edited or deleted (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS credit_notes_no_update_delete ON "credit_notes";
CREATE TRIGGER credit_notes_no_update_delete
  BEFORE UPDATE OR DELETE ON "credit_notes"
  FOR EACH ROW EXECUTE FUNCTION credit_notes_immutable();

-- Branch codes for the clinics there are: the letters of the place after the
-- dash ("Aura Clinic — Zamalek" → ZAM), else of the name; a repeat gets a digit.
WITH derived AS (
  SELECT id, "tenantId", "createdAt",
         COALESCE(NULLIF(upper(left(regexp_replace(COALESCE(NULLIF(trim(split_part(name, '—', 2)), ''), name), '[^A-Za-z]', '', 'g'), 3)), ''), 'BR') AS base
  FROM "clinics" WHERE code IS NULL
), ranked AS (
  SELECT id, base, row_number() OVER (PARTITION BY "tenantId", base ORDER BY "createdAt", id) AS dup FROM derived
)
UPDATE "clinics" c SET code = CASE WHEN r.dup = 1 THEN r.base ELSE r.base || r.dup END
FROM ranked r WHERE r.id = c.id;

-- Payments already taken: the branch (the visit's, else the clinic's first
-- location) and their receipt or refund voucher numbers, in the order the
-- money moved. A voided payment keeps its number: a number is never reused.
UPDATE "payments" p SET "clinicId" = a."clinicId"
FROM "appointments" a WHERE a.id = p."appointmentId" AND p."clinicId" IS NULL AND a."clinicId" IS NOT NULL;

UPDATE "payments" p SET "clinicId" = f.id
FROM (SELECT DISTINCT ON ("tenantId") id, "tenantId" FROM "clinics" WHERE "deletedAt" IS NULL ORDER BY "tenantId", "createdAt", id) f
WHERE f."tenantId" = p."tenantId" AND p."clinicId" IS NULL;

WITH numbered AS (
  SELECT p.id, p."clinicId", (p.kind = 'REFUND') AS refund,
         row_number() OVER (PARTITION BY p."tenantId", p."clinicId", (p.kind = 'REFUND') ORDER BY p."paidAt", p."createdAt", p.id) AS seq
  FROM "payments" p WHERE p."clinicId" IS NOT NULL
)
UPDATE "payments" p
SET "receiptSequence" = n.seq,
    "receiptNumber" = c.code || CASE WHEN n.refund THEN '-RF-' ELSE '-RC-' END || lpad(n.seq::text, 6, '0')
FROM numbered n JOIN "clinics" c ON c.id = n."clinicId"
WHERE n.id = p.id;

INSERT INTO "document_sequences" ("tenantId", "clinicId", kind, next)
SELECT "tenantId", "clinicId", CASE WHEN kind = 'REFUND' THEN 'REFUND' ELSE 'RECEIPT' END, max("receiptSequence") + 1
FROM "payments" WHERE "receiptSequence" IS NOT NULL
GROUP BY "tenantId", "clinicId", CASE WHEN kind = 'REFUND' THEN 'REFUND' ELSE 'RECEIPT' END;
