-- The cash drawer: cashiers' shifts (opening float, the money taken in them, the count at the close) and the
-- owner's sign-off of a branch's day, which locks the money on it.

-- CreateEnum
CREATE TYPE "CashShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "shiftId" TEXT;

-- CreateTable
CREATE TABLE "cash_shifts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "CashShiftStatus" NOT NULL DEFAULT 'OPEN',
    "openingFloat" INTEGER NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "counts" JSONB,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "day_closes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL,
    "closedById" TEXT,
    "totals" JSONB NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "day_closes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cash_shifts_tenantId_clinicId_openedAt_idx" ON "cash_shifts"("tenantId", "clinicId", "openedAt");

-- CreateIndex
CREATE INDEX "cash_shifts_tenantId_userId_status_idx" ON "cash_shifts"("tenantId", "userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "day_closes_tenantId_clinicId_day_key" ON "day_closes"("tenantId", "clinicId", "day");

-- CreateIndex
CREATE INDEX "payments_shiftId_idx" ON "payments"("shiftId");

-- AddForeignKey
ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "day_closes" ADD CONSTRAINT "day_closes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "day_closes" ADD CONSTRAINT "day_closes_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "cash_shifts"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- One open shift per cashier.
CREATE UNIQUE INDEX "cash_shifts_one_open_per_user" ON "cash_shifts"("tenantId", "userId") WHERE "status" = 'OPEN';

ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_float_not_negative" CHECK ("openingFloat" >= 0);
ALTER TABLE "day_closes" ADD CONSTRAINT "day_closes_day_format" CHECK ("day" ~ '^\d{4}-\d{2}-\d{2}$');

-- Row-level security, as on every clinic table (src/lib/db.ts).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cash_shifts', 'day_closes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = app_current_tenant()) WITH CHECK ("tenantId" = app_current_tenant())', t);
  END LOOP;
END $$;

-- A closed shift is never changed or reopened, a sign-off never edited, and neither is deleted. The audit
-- log's opt-in, set when a whole tenant is removed and its rows cascade, lets them go.
CREATE OR REPLACE FUNCTION cash_shifts_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cash shifts are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'a closed shift is never changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS cash_shifts_guard ON "cash_shifts";
CREATE TRIGGER cash_shifts_guard
  BEFORE UPDATE OR DELETE ON "cash_shifts"
  FOR EACH ROW EXECUTE FUNCTION cash_shifts_guard();

CREATE OR REPLACE FUNCTION day_closes_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'a signed-off day is never changed (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS day_closes_guard ON "day_closes";
CREATE TRIGGER day_closes_guard
  BEFORE UPDATE OR DELETE ON "day_closes"
  FOR EACH ROW EXECUTE FUNCTION day_closes_guard();

-- A signed-off day is locked: no payment is recorded on it, and none on it is changed or voided. The day is
-- the payment's date on its branch's clock.
CREATE OR REPLACE FUNCTION payments_day_lock() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  tz text;
  d text;
BEGIN
  IF current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."clinicId" IS NOT NULL THEN
    SELECT timezone INTO tz FROM "clinics" WHERE id = OLD."clinicId";
    d := to_char((OLD."paidAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(tz, 'Africa/Cairo'), 'YYYY-MM-DD');
    IF EXISTS (SELECT 1 FROM "day_closes" c WHERE c."tenantId" = OLD."tenantId" AND c."clinicId" = OLD."clinicId" AND c.day = d) THEN
      RAISE EXCEPTION 'the day % is signed off: the money on it is not changed', d USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."clinicId" IS NOT NULL THEN
    SELECT timezone INTO tz FROM "clinics" WHERE id = NEW."clinicId";
    d := to_char((NEW."paidAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(tz, 'Africa/Cairo'), 'YYYY-MM-DD');
    IF EXISTS (SELECT 1 FROM "day_closes" c WHERE c."tenantId" = NEW."tenantId" AND c."clinicId" = NEW."clinicId" AND c.day = d) THEN
      RAISE EXCEPTION 'the day % is signed off: no money is recorded on it', d USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS payments_day_lock ON "payments";
CREATE TRIGGER payments_day_lock
  BEFORE INSERT OR UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION payments_day_lock();
