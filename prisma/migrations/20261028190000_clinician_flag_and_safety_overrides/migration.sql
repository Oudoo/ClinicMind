-- Only clinicians sign. Signing clinical notes and procedures, and approving
-- concierge protocols, needs the role's consultations:sign permission AND this
-- per-person mark, set by the clinic owner. Existing doctors and owners keep
-- the right they had (physician-owner); the owner removes it from anyone who
-- is not a clinician.
ALTER TABLE "users" ADD COLUMN "isClinician" BOOLEAN NOT NULL DEFAULT false;
UPDATE "users" SET "isClinician" = true WHERE "role" IN ('DOCTOR', 'CLINIC_OWNER');

-- Prescribing-safety overrides: who overrode which warning or stop, and why.
CREATE TABLE "safety_overrides" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "consultationId" TEXT,
    "patientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "medication" TEXT,
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "safety_overrides_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "safety_overrides_tenantId_createdAt_idx" ON "safety_overrides"("tenantId", "createdAt");
CREATE INDEX "safety_overrides_tenantId_patientId_idx" ON "safety_overrides"("tenantId", "patientId");

ALTER TABLE "safety_overrides" ADD CONSTRAINT "safety_overrides_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "safety_overrides" ADD CONSTRAINT "safety_overrides_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "safety_overrides" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "safety_overrides";
CREATE POLICY tenant_isolation ON "safety_overrides" USING ("tenantId" = app_current_tenant()) WITH CHECK ("tenantId" = app_current_tenant());
