-- Phase 5D: lab work.

-- CreateEnum
CREATE TYPE "LabOrderStatus" AS ENUM ('SENT', 'RECEIVED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'LAB_ORDER_LATE';
ALTER TYPE "NotificationKind" ADD VALUE 'LAB_RESULT_IN';

-- AlterEnum
ALTER TYPE "TimelineKind" ADD VALUE 'LAB';

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "isLab" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "turnaroundDays" INTEGER;

-- CreateTable
CREATE TABLE "lab_orders" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "labId" TEXT NOT NULL,
    "procedureId" TEXT,
    "doctorId" TEXT,
    "tests" TEXT NOT NULL,
    "site" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "dueOn" DATE NOT NULL,
    "status" "LabOrderStatus" NOT NULL DEFAULT 'SENT',
    "receivedAt" TIMESTAMP(3),
    "receivedById" TEXT,
    "result" TEXT,
    "abnormal" BOOLEAN NOT NULL DEFAULT false,
    "expenseId" TEXT,
    "costId" TEXT,
    "lateNotifiedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lab_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_order_files" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "labOrderId" TEXT NOT NULL,
    "blobId" TEXT NOT NULL,
    "name" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lab_order_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lab_orders_expenseId_key" ON "lab_orders"("expenseId");

-- CreateIndex
CREATE UNIQUE INDEX "lab_orders_costId_key" ON "lab_orders"("costId");

-- CreateIndex
CREATE INDEX "lab_orders_tenantId_status_dueOn_idx" ON "lab_orders"("tenantId", "status", "dueOn");

-- CreateIndex
CREATE INDEX "lab_orders_tenantId_patientId_idx" ON "lab_orders"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "lab_orders_tenantId_labId_idx" ON "lab_orders"("tenantId", "labId");

-- CreateIndex
CREATE UNIQUE INDEX "lab_order_files_blobId_key" ON "lab_order_files"("blobId");

-- CreateIndex
CREATE INDEX "lab_order_files_tenantId_labOrderId_idx" ON "lab_order_files"("tenantId", "labOrderId");

-- AddForeignKey
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_labId_fkey" FOREIGN KEY ("labId") REFERENCES "suppliers"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "procedures"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_costId_fkey" FOREIGN KEY ("costId") REFERENCES "procedure_costs"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_order_files" ADD CONSTRAINT "lab_order_files_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_order_files" ADD CONSTRAINT "lab_order_files_labOrderId_fkey" FOREIGN KEY ("labOrderId") REFERENCES "lab_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_order_files" ADD CONSTRAINT "lab_order_files_blobId_fkey" FOREIGN KEY ("blobId") REFERENCES "file_blobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- What each row can be.
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_lab" CHECK ("turnaroundDays" IS NULL OR ("isLab" AND "turnaroundDays" BETWEEN 0 AND 90));
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_tests" CHECK (length(btrim("tests")) BETWEEN 2 AND 300);
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_received" CHECK (("status" = 'RECEIVED') = ("receivedAt" IS NOT NULL));
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_cancelled" CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL) AND ("cancelledAt" IS NULL) = ("cancelReason" IS NULL));
ALTER TABLE "lab_order_files" ADD CONSTRAINT "lab_order_files_size" CHECK ("sizeBytes" > 0);

-- Row-level security, as on every clinic table (src/lib/db.ts).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lab_orders', 'lab_order_files'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = app_current_tenant()) WITH CHECK ("tenantId" = app_current_tenant())', t);
  END LOOP;
END $$;

-- A lab order is never deleted: it is cancelled with a reason. It stays the
-- patient's, at its lab, and once cancelled it never changes; its bill is
-- replaced only once voided. Everything is allowed under the audit log's
-- opt-in, set when a whole tenant is removed.
CREATE OR REPLACE FUNCTION lab_orders_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a lab order is never deleted: cancel it with a reason'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'CANCELLED'
     OR (NEW."tenantId", NEW."patientId", NEW."labId", NEW."sentAt", NEW."createdById", NEW."createdAt")
        IS DISTINCT FROM (OLD."tenantId", OLD."patientId", OLD."labId", OLD."sentAt", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'a lab order keeps its patient, its lab and the day it was sent; cancelled, it never changes'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Its bill is replaced only once voided.
  IF OLD."expenseId" IS NOT NULL AND NEW."expenseId" IS DISTINCT FROM OLD."expenseId"
     AND NOT EXISTS (SELECT 1 FROM "expenses" WHERE id = OLD."expenseId" AND "voidedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'a lab order''s bill is replaced only once it is voided'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS lab_orders_guard ON "lab_orders";
CREATE TRIGGER lab_orders_guard
  BEFORE UPDATE OR DELETE ON "lab_orders"
  FOR EACH ROW EXECUTE FUNCTION lab_orders_guard();
