-- A notification kind for a prescription signed over a safety stop (the owner
-- reviews each one), and the index behind a doctor's own list of overrides.
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'SAFETY_OVERRIDE' BEFORE 'SYSTEM';

CREATE INDEX "safety_overrides_tenantId_userId_createdAt_idx" ON "safety_overrides"("tenantId", "userId", "createdAt");
