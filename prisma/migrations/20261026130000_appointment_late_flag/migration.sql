-- The appointments-late-flag job stamps this once per booking (its own column, so
-- patient reminders can use reminderSentAt independently).
ALTER TABLE "appointments" ADD COLUMN "lateFlaggedAt" TIMESTAMP(3);
