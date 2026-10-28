-- Phase 2 (finance): the clinic's price list. Items with a fixed code, a
-- category, a unit (visit, session, area, unit, tooth, arch, package) and the
-- treatment they bill for; prices from a date, per branch or clinic-wide,
-- never edited once in force. Procedures remember the item and the quantity.

-- CreateEnum
CREATE TYPE "PriceUnit" AS ENUM ('VISIT', 'SESSION', 'AREA', 'UNIT', 'TOOTH', 'ARCH', 'PACKAGE');

-- AlterTable
ALTER TABLE "procedures" ADD COLUMN     "priceItemId" TEXT,
ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "price_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "unit" "PriceUnit" NOT NULL DEFAULT 'SESSION',
    "unitLabel" TEXT,
    "treatmentId" TEXT NOT NULL,
    "sessions" INTEGER,
    "sessionItemId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_item_prices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "priceItemId" TEXT NOT NULL,
    "clinicId" TEXT,
    "amount" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_item_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "price_items_tenantId_category_idx" ON "price_items"("tenantId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "price_items_tenantId_code_key" ON "price_items"("tenantId", "code");

-- CreateIndex
CREATE INDEX "price_item_prices_tenantId_priceItemId_effectiveFrom_idx" ON "price_item_prices"("tenantId", "priceItemId", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "procedures" ADD CONSTRAINT "procedures_priceItemId_fkey" FOREIGN KEY ("priceItemId") REFERENCES "price_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_items" ADD CONSTRAINT "price_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_items" ADD CONSTRAINT "price_items_treatmentId_fkey" FOREIGN KEY ("treatmentId") REFERENCES "treatments"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_items" ADD CONSTRAINT "price_items_sessionItemId_fkey" FOREIGN KEY ("sessionItemId") REFERENCES "price_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_item_prices" ADD CONSTRAINT "price_item_prices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_item_prices" ADD CONSTRAINT "price_item_prices_priceItemId_fkey" FOREIGN KEY ("priceItemId") REFERENCES "price_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_item_prices" ADD CONSTRAINT "price_item_prices_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security, as on every clinic table (src/lib/db.ts).
ALTER TABLE "price_items" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "price_items";
CREATE POLICY tenant_isolation ON "price_items" USING ("tenantId" = app_current_tenant()) WITH CHECK ("tenantId" = app_current_tenant());
ALTER TABLE "price_item_prices" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "price_item_prices";
CREATE POLICY tenant_isolation ON "price_item_prices" USING ("tenantId" = app_current_tenant()) WITH CHECK ("tenantId" = app_current_tenant());
