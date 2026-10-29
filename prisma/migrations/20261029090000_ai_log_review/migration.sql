-- Phase 4: log and review. Every AI question and answer, every rating and every
-- prescribing-safety override is kept for good; doctors rate the answers they
-- asked for; the owner gets a monthly review.

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'AI_REVIEW';

-- CreateTable
CREATE TABLE "ai_feedback" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "helpful" BOOLEAN NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_feedback_tenantId_createdAt_idx" ON "ai_feedback"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_feedback_runId_idx" ON "ai_feedback"("runId");

-- AddForeignKey
ALTER TABLE "ai_feedback" ADD CONSTRAINT "ai_feedback_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_feedback" ADD CONSTRAINT "ai_feedback_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ai_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_feedback" ADD CONSTRAINT "ai_feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_feedback" ADD CONSTRAINT "ai_feedback_comment_length" CHECK ("comment" IS NULL OR char_length("comment") <= 1000);

-- Row-level security, as on every clinic table (src/lib/db.ts).
ALTER TABLE "ai_feedback" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ai_feedback";
CREATE POLICY tenant_isolation ON "ai_feedback" USING ("tenantId" = app_current_tenant()) WITH CHECK ("tenantId" = app_current_tenant());

-- Kept for good: never edited or deleted, except when a whole tenant is
-- removed (the audit log's opt-in, under which its rows cascade, and a removed
-- author's runs lose their author).
CREATE OR REPLACE FUNCTION ai_log_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_audit_delete', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is kept for good (% refused)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS ai_runs_no_update_delete ON "ai_runs";
CREATE TRIGGER ai_runs_no_update_delete
  BEFORE UPDATE OR DELETE ON "ai_runs"
  FOR EACH ROW EXECUTE FUNCTION ai_log_immutable();

DROP TRIGGER IF EXISTS ai_feedback_no_update_delete ON "ai_feedback";
CREATE TRIGGER ai_feedback_no_update_delete
  BEFORE UPDATE OR DELETE ON "ai_feedback"
  FOR EACH ROW EXECUTE FUNCTION ai_log_immutable();

DROP TRIGGER IF EXISTS safety_overrides_no_update_delete ON "safety_overrides";
CREATE TRIGGER safety_overrides_no_update_delete
  BEFORE UPDATE OR DELETE ON "safety_overrides"
  FOR EACH ROW EXECUTE FUNCTION ai_log_immutable();
