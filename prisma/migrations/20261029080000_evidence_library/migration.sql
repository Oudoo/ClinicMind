-- The clinic's evidence library (Phase 4): the sources it approves for the evidence panel (guidelines, drug
-- information, its own protocols) and their passages, searched and cited by the panel. And the patient's
-- recorded pregnancy status with the day it was checked, for the panel's context and the safety checks.

-- CreateEnum
CREATE TYPE "PregnancyStatus" AS ENUM ('PREGNANT', 'NOT_PREGNANT');

-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('GUIDELINE', 'DRUG_INFO', 'PROTOCOL');

-- CreateEnum
CREATE TYPE "EvidenceStatus" AS ENUM ('DRAFT', 'APPROVED', 'RETIRED');

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "pregnancyCheckedAt" TIMESTAMP(3),
ADD COLUMN     "pregnancyStatus" "PregnancyStatus";

-- CreateTable
CREATE TABLE "evidence_sources" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "EvidenceKind" NOT NULL,
    "publisher" TEXT,
    "year" INTEGER,
    "url" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "body" TEXT NOT NULL,
    "status" "EvidenceStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "evidence_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_passages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "heading" TEXT,
    "content" TEXT NOT NULL,

    CONSTRAINT "evidence_passages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "evidence_sources_tenantId_status_idx" ON "evidence_sources"("tenantId", "status");

-- CreateIndex
CREATE INDEX "evidence_passages_tenantId_idx" ON "evidence_passages"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_passages_sourceId_index_key" ON "evidence_passages"("sourceId", "index");

-- AddForeignKey
ALTER TABLE "evidence_sources" ADD CONSTRAINT "evidence_sources_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_passages" ADD CONSTRAINT "evidence_passages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_passages" ADD CONSTRAINT "evidence_passages_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "evidence_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A status and the day it was checked go together; an approved source says when, a retired one too.
ALTER TABLE "patients" ADD CONSTRAINT "patients_pregnancy_checked" CHECK (("pregnancyStatus" IS NULL) = ("pregnancyCheckedAt" IS NULL));
ALTER TABLE "evidence_sources" ADD CONSTRAINT "evidence_sources_approved" CHECK ("status" <> 'APPROVED' OR "approvedAt" IS NOT NULL);
ALTER TABLE "evidence_sources" ADD CONSTRAINT "evidence_sources_retired" CHECK (("status" = 'RETIRED') = ("retiredAt" IS NOT NULL));
ALTER TABLE "evidence_sources" ADD CONSTRAINT "evidence_sources_year" CHECK ("year" IS NULL OR "year" BETWEEN 1900 AND 2100);
ALTER TABLE "evidence_sources" ADD CONSTRAINT "evidence_sources_language" CHECK ("language" IN ('ar', 'en'));

-- Row-level security, as on every clinic table (src/lib/db.ts).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['evidence_sources', 'evidence_passages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = app_current_tenant()) WITH CHECK ("tenantId" = app_current_tenant())', t);
  END LOOP;
END $$;
