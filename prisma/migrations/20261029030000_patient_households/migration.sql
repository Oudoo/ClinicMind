-- Family accounts: the family member who pays for a patient (the head of the household).

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "householdHeadId" TEXT,
ADD COLUMN     "householdRelation" TEXT;

-- CreateIndex
CREATE INDEX "patients_tenantId_householdHeadId_idx" ON "patients"("tenantId", "householdHeadId");

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_householdHeadId_fkey" FOREIGN KEY ("householdHeadId") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "patients" ADD CONSTRAINT "patients_household_relation_check"
  CHECK ("householdRelation" IS NULL OR "householdRelation" IN ('SPOUSE', 'CHILD', 'PARENT', 'SIBLING', 'OTHER'));

-- One level of family: the head is a patient of the same clinic with no head of their own, and a patient
-- who pays for others does not join another family. The head's row is locked while this is checked, so
-- two changes made at once cannot build a chain between them.
CREATE OR REPLACE FUNCTION patients_household_guard() RETURNS trigger AS $$
DECLARE
  head_tenant TEXT;
  head_head TEXT;
BEGIN
  IF NEW."householdHeadId" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."householdHeadId" = NEW.id THEN
    RAISE EXCEPTION 'a patient is not the head of their own family' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "tenantId", "householdHeadId" INTO head_tenant, head_head FROM "patients" WHERE id = NEW."householdHeadId" FOR UPDATE;
  IF head_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'the head of a family is a patient of the same clinic' USING ERRCODE = 'check_violation';
  END IF;
  IF head_head IS NOT NULL THEN
    RAISE EXCEPTION 'the head of a family has no head of their own' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "patients" WHERE "householdHeadId" = NEW.id) THEN
    RAISE EXCEPTION 'a patient who pays for others does not join another family' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER patients_household_guard
  BEFORE INSERT OR UPDATE OF "householdHeadId" ON "patients"
  FOR EACH ROW EXECUTE FUNCTION patients_household_guard();
