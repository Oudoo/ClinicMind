-- The patient's last weight and the day it was taken: per-kilogram doses are checked against it.

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "weighedAt" TIMESTAMP(3),
ADD COLUMN     "weightKg" DOUBLE PRECISION;

-- A weight and its day go together; a person weighs between 1 and 400 kg.
ALTER TABLE "patients" ADD CONSTRAINT "patients_weight_dated" CHECK (("weightKg" IS NULL) = ("weighedAt" IS NULL));
ALTER TABLE "patients" ADD CONSTRAINT "patients_weight_range" CHECK ("weightKg" IS NULL OR "weightKg" BETWEEN 1 AND 400);
