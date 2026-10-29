-- Phase 5E: expenses and suppliers.

-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('RENT', 'SALARIES', 'UTILITIES', 'SUPPLIES', 'LAB', 'EQUIPMENT', 'MAINTENANCE', 'MARKETING', 'FEES', 'LICENCES', 'BANK', 'CLEANING', 'HOSPITALITY', 'TRANSPORT', 'OTHER');


-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ExpenseCategory" NOT NULL DEFAULT 'OTHER',
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "notes" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "supplierId" TEXT,
    "category" "ExpenseCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "billedOn" DATE NOT NULL,
    "dueOn" DATE,
    "amount" INTEGER NOT NULL,
    "recurringId" TEXT,
    "period" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_payments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "shiftId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,

    CONSTRAINT "expense_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_files" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "blobId" TEXT NOT NULL,
    "name" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_expenses" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "supplierId" TEXT,
    "category" "ExpenseCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "everyMonths" INTEGER NOT NULL DEFAULT 1,
    "dayOfMonth" INTEGER NOT NULL,
    "dueDays" INTEGER NOT NULL DEFAULT 0,
    "startMonth" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "stoppedAt" TIMESTAMP(3),
    "stoppedById" TEXT,
    "stopReason" TEXT,

    CONSTRAINT "recurring_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "suppliers_tenantId_idx" ON "suppliers"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_tenantId_name_key" ON "suppliers"("tenantId", "name");

-- CreateIndex
CREATE INDEX "expenses_tenantId_billedOn_idx" ON "expenses"("tenantId", "billedOn");

-- CreateIndex
CREATE INDEX "expenses_tenantId_supplierId_idx" ON "expenses"("tenantId", "supplierId");

-- CreateIndex
CREATE INDEX "expenses_tenantId_dueOn_idx" ON "expenses"("tenantId", "dueOn");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_tenantId_recurringId_period_key" ON "expenses"("tenantId", "recurringId", "period");

-- CreateIndex
CREATE INDEX "expense_payments_tenantId_expenseId_idx" ON "expense_payments"("tenantId", "expenseId");

-- CreateIndex
CREATE INDEX "expense_payments_tenantId_shiftId_idx" ON "expense_payments"("tenantId", "shiftId");

-- CreateIndex
CREATE INDEX "expense_payments_tenantId_paidAt_idx" ON "expense_payments"("tenantId", "paidAt");

-- CreateIndex
CREATE UNIQUE INDEX "expense_files_blobId_key" ON "expense_files"("blobId");

-- CreateIndex
CREATE INDEX "expense_files_tenantId_expenseId_idx" ON "expense_files"("tenantId", "expenseId");

-- CreateIndex
CREATE INDEX "recurring_expenses_tenantId_idx" ON "recurring_expenses"("tenantId");

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_recurringId_fkey" FOREIGN KEY ("recurringId") REFERENCES "recurring_expenses"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "cash_shifts"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_files" ADD CONSTRAINT "expense_files_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_files" ADD CONSTRAINT "expense_files_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_files" ADD CONSTRAINT "expense_files_blobId_fkey" FOREIGN KEY ("blobId") REFERENCES "file_blobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- What each row can be.
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_name" CHECK (length(btrim("name")) BETWEEN 1 AND 120);
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_amount" CHECK ("amount" > 0);
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_description" CHECK (length(btrim("description")) BETWEEN 1 AND 200);
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_due" CHECK ("dueOn" IS NULL OR "dueOn" >= "billedOn");
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_recurring" CHECK (
  ("recurringId" IS NULL) = ("period" IS NULL)
  AND ("period" IS NULL OR "period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_voided" CHECK (("voidedAt" IS NULL) = ("voidReason" IS NULL));
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_amount" CHECK ("amount" > 0);
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_drawer" CHECK ("shiftId" IS NULL OR "method" = 'CASH');
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_voided" CHECK (("voidedAt" IS NULL) = ("voidReason" IS NULL));
ALTER TABLE "expense_files" ADD CONSTRAINT "expense_files_size" CHECK ("sizeBytes" > 0);
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_terms" CHECK (
  "amount" > 0
  AND "everyMonths" IN (1, 2, 3, 6, 12)
  AND "dayOfMonth" BETWEEN 1 AND 28
  AND "dueDays" BETWEEN 0 AND 90
  AND "startMonth" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  AND length(btrim("description")) BETWEEN 1 AND 200
);
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_stopped" CHECK (("stoppedAt" IS NULL) = ("stopReason" IS NULL));

-- Row-level security, as on every clinic table (src/lib/db.ts).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['suppliers', 'expenses', 'expense_payments', 'expense_files', 'recurring_expenses'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = app_current_tenant()) WITH CHECK ("tenantId" = app_current_tenant())', t);
  END LOOP;
END $$;

-- An expense is never deleted: it is voided with a reason, and once voided it
-- never changes. Its amount never goes below what is paid towards it. A
-- payment is never deleted or changed: it is voided (once) with a reason, and
-- never takes an expense past its amount or pays a voided one. A recurring
-- expense is stopped, never deleted, and once stopped never changes.
-- Everything is allowed under the audit log's opt-in, set when a whole tenant
-- is removed.
CREATE OR REPLACE FUNCTION expenses_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE paid integer;
BEGIN
  IF current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an expense is never deleted: void it with a reason'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."voidedAt" IS NOT NULL
     OR (NEW."tenantId", NEW."recurringId", NEW.period, NEW."createdById", NEW."createdAt")
        IS DISTINCT FROM (OLD."tenantId", OLD."recurringId", OLD.period, OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'a voided expense never changes, and an expense keeps where it came from'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.amount < OLD.amount THEN
    SELECT COALESCE(sum(amount), 0) INTO paid FROM "expense_payments" WHERE "expenseId" = NEW.id AND "voidedAt" IS NULL;
    IF NEW.amount < paid THEN
      RAISE EXCEPTION 'an expense is never less than what is paid towards it'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS expenses_guard ON "expenses";
CREATE TRIGGER expenses_guard
  BEFORE UPDATE OR DELETE ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION expenses_guard();

CREATE OR REPLACE FUNCTION expense_payments_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE e record; paid integer;
BEGIN
  IF current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a payment towards an expense is never deleted: void it with a reason'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- One payment at a time per expense: the expense row is locked first.
    SELECT amount, "voidedAt", "tenantId" INTO e FROM "expenses" WHERE id = NEW."expenseId" FOR UPDATE;
    IF e."voidedAt" IS NOT NULL OR e."tenantId" IS DISTINCT FROM NEW."tenantId" THEN
      RAISE EXCEPTION 'a voided expense takes no payment'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."voidedAt" IS NULL THEN
      SELECT COALESCE(sum(amount), 0) INTO paid FROM "expense_payments" WHERE "expenseId" = NEW."expenseId" AND "voidedAt" IS NULL;
      IF paid + NEW.amount > e.amount THEN
        RAISE EXCEPTION 'a payment never takes an expense past its amount'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."voidedAt" IS NOT NULL OR NEW."voidedAt" IS NULL
     OR (NEW."tenantId", NEW."expenseId", NEW."clinicId", NEW.amount, NEW.method, NEW."paidAt", NEW.reference, NEW."shiftId", NEW.note, NEW."createdById", NEW."createdAt")
        IS DISTINCT FROM (OLD."tenantId", OLD."expenseId", OLD."clinicId", OLD.amount, OLD.method, OLD."paidAt", OLD.reference, OLD."shiftId", OLD.note, OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'a payment towards an expense never changes: void it with a reason'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS expense_payments_guard ON "expense_payments";
CREATE TRIGGER expense_payments_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "expense_payments"
  FOR EACH ROW EXECUTE FUNCTION expense_payments_guard();

CREATE OR REPLACE FUNCTION recurring_expenses_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a recurring expense is never deleted: stop it with a reason'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."stoppedAt" IS NOT NULL
     OR (NEW."tenantId", NEW."startMonth", NEW."createdById", NEW."createdAt")
        IS DISTINCT FROM (OLD."tenantId", OLD."startMonth", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'a stopped recurring expense never changes, and its first month stays'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS recurring_expenses_guard ON "recurring_expenses";
CREATE TRIGGER recurring_expenses_guard
  BEFORE UPDATE OR DELETE ON "recurring_expenses"
  FOR EACH ROW EXECUTE FUNCTION recurring_expenses_guard();
