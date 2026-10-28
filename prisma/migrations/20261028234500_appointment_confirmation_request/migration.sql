-- A moved appointment asks the patient to confirm the new time (WhatsApp,
-- reply 1 to confirm or 2 for another time): when the request went out.
ALTER TABLE "appointments" ADD COLUMN "confirmationRequestedAt" TIMESTAMP(3);
