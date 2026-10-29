-- Reminders and consents: a patient's two consents (treatment reminders, on unless they say no; offers and
-- news, off unless they say yes), and the stamps of an appointment's reminders (48 hours and 2 hours before),
-- of the call the day before when it is still unconfirmed, and of the patient asking for another time.

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'BOOKING_UNCONFIRMED';

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "confirmCallFlaggedAt" TIMESTAMP(3),
ADD COLUMN     "finalReminderSentAt" TIMESTAMP(3),
ADD COLUMN     "rescheduleRequestedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "marketingConsentAt" TIMESTAMP(3),
ADD COLUMN     "reminderConsent" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "reminderConsentAt" TIMESTAMP(3);

-- The reminder job looks for live bookings in the next two days.
CREATE INDEX "appointments_reminders_due_idx" ON "appointments"("tenantId", "startsAt") WHERE "deletedAt" IS NULL AND status IN ('SCHEDULED', 'CONFIRMED');
