-- Discounts with a reason and who gave them; discounts taken off charges already posted; write-offs.

-- AlterTable
ALTER TABLE "charges" ADD COLUMN     "discountOfId" TEXT,
ADD COLUMN     "reason" TEXT;

-- AlterTable
ALTER TABLE "procedures" ADD COLUMN     "discountById" TEXT,
ADD COLUMN     "discountNote" TEXT,
ADD COLUMN     "discountReason" TEXT;

-- CreateTable
CREATE TABLE "write_offs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "writtenOffAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "write_offs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "write_offs_tenantId_writtenOffAt_idx" ON "write_offs"("tenantId", "writtenOffAt");

-- CreateIndex
CREATE INDEX "write_offs_tenantId_patientId_idx" ON "write_offs"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "write_offs_invoiceId_idx" ON "write_offs"("invoiceId");

-- CreateIndex
CREATE INDEX "charges_discountOfId_idx" ON "charges"("discountOfId");

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_discountOfId_fkey" FOREIGN KEY ("discountOfId") REFERENCES "charges"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "write_offs" ADD CONSTRAINT "write_offs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "write_offs" ADD CONSTRAINT "write_offs_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "write_offs" ADD CONSTRAINT "write_offs_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "write_offs" ADD CONSTRAINT "write_offs_amount_positive" CHECK ("amount" > 0);

-- Discounts given before their reasons were recorded.
UPDATE "procedures" SET "discountReason" = 'OTHER', "discountNote" = 'Given before discount reasons were recorded'
WHERE "discount" > 0 AND "discountReason" IS NULL;

-- Row-level security, as on every clinic table (src/lib/db.ts).
ALTER TABLE "write_offs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "write_offs";
CREATE POLICY tenant_isolation ON "write_offs" USING ("tenantId" = app_current_tenant()) WITH CHECK ("tenantId" = app_current_tenant());

-- A write-off is never edited or deleted: it is only voided, once, with the invoice it was on. Deleting is
-- allowed with the audit log's opt-in, set when a whole tenant is removed and its rows cascade.
CREATE OR REPLACE FUNCTION write_offs_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_audit_delete', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'write-offs are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."voidedAt" IS NULL AND NEW."voidedAt" IS NOT NULL
    AND (NEW.id, NEW."tenantId", NEW."patientId", NEW."invoiceId", NEW.amount, NEW.reason, NEW.note, NEW."writtenOffAt", NEW."createdById", NEW."createdAt")
      IS NOT DISTINCT FROM (OLD.id, OLD."tenantId", OLD."patientId", OLD."invoiceId", OLD.amount, OLD.reason, OLD.note, OLD."writtenOffAt", OLD."createdById", OLD."createdAt") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'write-offs are never edited, only voided with their invoice' USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS write_offs_guard ON "write_offs";
CREATE TRIGGER write_offs_guard
  BEFORE UPDATE OR DELETE ON "write_offs"
  FOR EACH ROW EXECUTE FUNCTION write_offs_guard();
