-- Phase 5 (finance): treatment plans and quotes. A quote is a plan of
-- price-list items in phases, with sessions, the quoted price and discount
-- and the last day it holds, given to the patient in Arabic or English
-- (printed, or on WhatsApp behind a link). It is numbered per branch when
-- first given ("ZAM-QT-000012"), and from then on its items and prices never
-- change. The patient accepts it, all of it or some items, with a signature;
-- the accepted items become planned procedures at the quoted prices, with no
-- day yet ("undated"): work done at once is dated the day it is signed.

-- A patient accepted or declined a treatment plan behind its link.
ALTER TYPE "NotificationKind" ADD VALUE 'QUOTE_ANSWERED';

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'WITHDRAWN');

-- AlterTable
ALTER TABLE "procedures" ADD COLUMN     "undated" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "doctorId" TEXT,
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "sequence" INTEGER,
    "number" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "title" TEXT,
    "phases" TEXT[],
    "note" TEXT,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "sentById" TEXT,
    "shareTokenHash" TEXT,
    "linkSentAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "acceptedName" TEXT,
    "signature" TEXT,
    "acceptedVia" TEXT,
    "acceptedById" TEXT,
    "acceptedTotal" INTEGER,
    "declinedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnReason" TEXT,
    "revisionOfId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "phase" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL,
    "priceItemId" TEXT NOT NULL,
    "treatmentId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "site" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "stages" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" INTEGER NOT NULL,
    "price" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "discountReason" TEXT,
    "discountNote" TEXT,
    "discountById" TEXT,
    "accepted" BOOLEAN,
    "procedureId" TEXT,

CONSTRAINT "quote_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quotes_shareTokenHash_key" ON "quotes"("shareTokenHash");

-- CreateIndex
CREATE INDEX "quotes_tenantId_patientId_idx" ON "quotes"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "quotes_tenantId_status_sentAt_idx" ON "quotes"("tenantId", "status", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_tenantId_clinicId_sequence_key" ON "quotes"("tenantId", "clinicId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_tenantId_number_key" ON "quotes"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "quote_items_procedureId_key" ON "quote_items"("procedureId");

-- CreateIndex
CREATE INDEX "quote_items_tenantId_quoteId_idx" ON "quote_items"("tenantId", "quoteId");

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_priceItemId_fkey" FOREIGN KEY ("priceItemId") REFERENCES "price_items"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_treatmentId_fkey" FOREIGN KEY ("treatmentId") REFERENCES "treatments"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "procedures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- What a quote can be.
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_language" CHECK ("language" IN ('ar', 'en'));
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_total" CHECK ("total" >= 0 AND ("acceptedTotal" IS NULL OR "acceptedTotal" BETWEEN 0 AND "total"));
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_given" CHECK ("status" = 'DRAFT' OR ("number" IS NOT NULL AND "sequence" IS NOT NULL AND "sentAt" IS NOT NULL));
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_accepted" CHECK (
  ("status" = 'ACCEPTED') = ("acceptedAt" IS NOT NULL)
  AND ("status" <> 'ACCEPTED' OR ("acceptedName" IS NOT NULL AND "signature" IS NOT NULL AND "acceptedTotal" IS NOT NULL AND "acceptedVia" IN ('clinic', 'link')))
);
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_declined" CHECK (("status" = 'DECLINED') = ("declinedAt" IS NOT NULL));
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_withdrawn" CHECK (("status" = 'WITHDRAWN') = ("withdrawnAt" IS NOT NULL));
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_phases" CHECK (cardinality("phases") BETWEEN 1 AND 12);
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_amounts" CHECK (
  "quantity" >= 1 AND "stages" >= 1 AND "phase" >= 0 AND "unitPrice" >= 0 AND "price" >= 0
  AND "discount" >= 0 AND "discount" <= "price"
);
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_discount_reason" CHECK ("discount" = 0 OR "discountReason" IS NOT NULL);

-- Row-level security, as on every clinic table (src/lib/db.ts).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quotes', 'quote_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = app_current_tenant()) WITH CHECK ("tenantId" = app_current_tenant())', t);
  END LOOP;
END $$;

-- A quote given to the patient keeps its number, branch, patient, doctor,
-- headings, items and prices, and is never deleted (only a draft is). While
-- it is open it can be extended, re-sent, or accepted, declined or withdrawn;
-- after that it is final (its language aside: a copy can be printed in the
-- other). Everything is allowed under the audit log's opt-in, set when a
-- whole tenant is removed and its rows cascade.
CREATE OR REPLACE FUNCTION quotes_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'DRAFT' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'a quote given to the patient is never deleted: withdraw it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'DRAFT'
    OR (NEW.number, NEW.sequence, NEW."clinicId", NEW."patientId", NEW."doctorId", NEW.title, NEW.phases, NEW.note, NEW.total, NEW."sentAt", NEW."sentById", NEW."revisionOfId", NEW."createdById")
       IS DISTINCT FROM (OLD.number, OLD.sequence, OLD."clinicId", OLD."patientId", OLD."doctorId", OLD.title, OLD.phases, OLD.note, OLD.total, OLD."sentAt", OLD."sentById", OLD."revisionOfId", OLD."createdById") THEN
    RAISE EXCEPTION 'a quote given to the patient keeps its number, patient, items and prices'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'SENT'
    AND (NEW.status, NEW."validUntil", NEW."shareTokenHash", NEW."linkSentAt", NEW."acceptedAt", NEW."acceptedName", NEW.signature, NEW."acceptedVia", NEW."acceptedById", NEW."acceptedTotal", NEW."declinedAt", NEW."declineReason", NEW."withdrawnAt", NEW."withdrawnReason")
       IS DISTINCT FROM (OLD.status, OLD."validUntil", OLD."shareTokenHash", OLD."linkSentAt", OLD."acceptedAt", OLD."acceptedName", OLD.signature, OLD."acceptedVia", OLD."acceptedById", OLD."acceptedTotal", OLD."declinedAt", OLD."declineReason", OLD."withdrawnAt", OLD."withdrawnReason") THEN
    RAISE EXCEPTION 'an accepted, declined or withdrawn quote is final'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS quotes_guard ON "quotes";
CREATE TRIGGER quotes_guard
  BEFORE UPDATE OR DELETE ON "quotes"
  FOR EACH ROW EXECUTE FUNCTION quotes_guard();

-- A draft's items change freely (and go with it when it is discarded). Once
-- the quote is given, accepting it marks each item and links the procedure it
-- became; nothing else about an item ever changes.
CREATE OR REPLACE FUNCTION quote_items_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
  IF current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  SELECT status::text INTO parent_status FROM "quotes" WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD."quoteId" ELSE NEW."quoteId" END;
  IF parent_status IS NULL OR parent_status = 'DRAFT' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE' AND parent_status = 'SENT'
    AND (NEW."tenantId", NEW."quoteId", NEW.phase, NEW.position, NEW."priceItemId", NEW."treatmentId", NEW.description, NEW.site, NEW.quantity, NEW.stages, NEW."unitPrice", NEW.price, NEW.discount, NEW."discountReason", NEW."discountNote", NEW."discountById")
        IS NOT DISTINCT FROM (OLD."tenantId", OLD."quoteId", OLD.phase, OLD.position, OLD."priceItemId", OLD."treatmentId", OLD.description, OLD.site, OLD.quantity, OLD.stages, OLD."unitPrice", OLD.price, OLD.discount, OLD."discountReason", OLD."discountNote", OLD."discountById") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the items of a quote given to the patient never change'
    USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS quote_items_guard ON "quote_items";
CREATE TRIGGER quote_items_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "quote_items"
  FOR EACH ROW EXECUTE FUNCTION quote_items_guard();
