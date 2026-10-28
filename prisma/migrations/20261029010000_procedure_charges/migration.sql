-- Phase 2 (finance): procedures become charges. Work done in stages (the
-- sessions of a course) is started on a day and each stage's share is charged
-- as it is done; a procedure is charged when it is signed; a charge of nothing
-- carries its reason. Charges are never edited: a correction is a reversing row.

-- AlterEnum
ALTER TYPE "ProcedureStatus" ADD VALUE IF NOT EXISTS 'STARTED' BEFORE 'SIGNED';

-- AlterTable
ALTER TABLE "procedures" ADD COLUMN     "stages" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "startedById" TEXT,
ADD COLUMN     "zeroChargeReason" TEXT;

-- CreateTable
CREATE TABLE "charges" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "procedureId" TEXT,
    "appointmentId" TEXT,
    "stage" INTEGER,
    "amount" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "chargedAt" TIMESTAMP(3) NOT NULL,
    "doctorId" TEXT,
    "clinicId" TEXT,
    "reversalOfId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "charges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "charges_reversalOfId_key" ON "charges"("reversalOfId");

-- CreateIndex
CREATE INDEX "charges_tenantId_chargedAt_idx" ON "charges"("tenantId", "chargedAt");

-- CreateIndex
CREATE INDEX "charges_tenantId_patientId_idx" ON "charges"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "charges_tenantId_appointmentId_idx" ON "charges"("tenantId", "appointmentId");

-- CreateIndex
CREATE INDEX "charges_procedureId_idx" ON "charges"("procedureId");

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "procedures"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "charges"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Row-level security, as on every clinic table (src/lib/db.ts).
ALTER TABLE "charges" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "charges";
CREATE POLICY tenant_isolation ON "charges" USING ("tenantId" = app_current_tenant()) WITH CHECK ("tenantId" = app_current_tenant());

-- Never edited; deleted only with the audit log's opt-in, set when a whole
-- tenant is removed and its rows cascade.
CREATE OR REPLACE FUNCTION charges_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'charges are never edited or deleted (% refused): post a reversing charge', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS charges_no_update_delete ON "charges";
CREATE TRIGGER charges_no_update_delete
  BEFORE UPDATE OR DELETE ON "charges"
  FOR EACH ROW EXECUTE FUNCTION charges_immutable();

-- What was signed before charges existed is charged now, on the day it was done.
INSERT INTO "charges" ("id", "tenantId", "patientId", "procedureId", "appointmentId", "amount", "description", "chargedAt", "doctorId", "clinicId", "createdById", "createdAt")
SELECT
  'c' || replace(gen_random_uuid()::text, '-', ''),
  p."tenantId",
  p."patientId",
  p."id",
  p."appointmentId",
  p."price" - p."discount",
  COALESCE(i."name", t."name") || CASE WHEN p."quantity" > 1 THEN ' × ' || p."quantity" ELSE '' END,
  p."performedAt",
  p."doctorId",
  a."clinicId",
  p."signedById",
  COALESCE(p."signedAt", p."updatedAt")
FROM "procedures" p
JOIN "treatments" t ON t."id" = p."treatmentId"
LEFT JOIN "price_items" i ON i."id" = p."priceItemId"
LEFT JOIN "appointments" a ON a."id" = p."appointmentId"
WHERE p."status" = 'SIGNED' AND p."deletedAt" IS NULL;
