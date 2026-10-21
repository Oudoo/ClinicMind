-- ─────────────────────────────────────────────────────────────────────────────
-- ClinicMind — upgrade an EXISTING database to the tenant-scope schema (SEC-2,
-- SEC-4). Fresh databases do not need this: `prisma db push` creates the final
-- shape directly, and running this file afterwards is a harmless no-op.
--
-- Run it BEFORE `prisma db push` on a database that already holds data:
--
--   psql "${DATABASE_URL%%\?*}" -f prisma/sql/02_tenant_scope_upgrade.sql
--   npx prisma db push
--
-- It adds `tenantId` to medical_histories, medications, documents and messages,
-- back-fills it from the parent patient / conversation, and replaces the
-- plaintext embed "public key" with the hashed embed secret columns. Every
-- statement is idempotent. Constraint and index names match what Prisma
-- generates, so the subsequent `db push` finds nothing left to change.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── medical_histories ← patients ─────────────────────────────────────────────
ALTER TABLE medical_histories ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
UPDATE medical_histories mh
   SET "tenantId" = p."tenantId"
  FROM patients p
 WHERE p.id = mh."patientId" AND mh."tenantId" IS NULL;
ALTER TABLE medical_histories ALTER COLUMN "tenantId" SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medical_histories_tenantId_fkey') THEN
    ALTER TABLE medical_histories
      ADD CONSTRAINT "medical_histories_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES tenants(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "medical_histories_tenantId_idx" ON medical_histories("tenantId");

-- ── medications ← patients ───────────────────────────────────────────────────
ALTER TABLE medications ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
UPDATE medications m
   SET "tenantId" = p."tenantId"
  FROM patients p
 WHERE p.id = m."patientId" AND m."tenantId" IS NULL;
ALTER TABLE medications ALTER COLUMN "tenantId" SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medications_tenantId_fkey') THEN
    ALTER TABLE medications
      ADD CONSTRAINT "medications_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES tenants(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "medications_tenantId_idx" ON medications("tenantId");

-- ── documents ← patients ─────────────────────────────────────────────────────
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
UPDATE documents d
   SET "tenantId" = p."tenantId"
  FROM patients p
 WHERE p.id = d."patientId" AND d."tenantId" IS NULL;
ALTER TABLE documents ALTER COLUMN "tenantId" SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_tenantId_fkey') THEN
    ALTER TABLE documents
      ADD CONSTRAINT "documents_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES tenants(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "documents_tenantId_idx" ON documents("tenantId");

-- ── messages ← conversations ─────────────────────────────────────────────────
ALTER TABLE messages ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
UPDATE messages m
   SET "tenantId" = c."tenantId"
  FROM conversations c
 WHERE c.id = m."conversationId" AND m."tenantId" IS NULL;
ALTER TABLE messages ALTER COLUMN "tenantId" SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_tenantId_fkey') THEN
    ALTER TABLE messages
      ADD CONSTRAINT "messages_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES tenants(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "messages_tenantId_idx" ON messages("tenantId");

-- ── tenant_embed_configs: plaintext key → hashed secret (SEC-2) ──────────────
-- Dropping the old key invalidates every integration that still presents it;
-- each tenant generates a new secret from Settings → Embed (shown once).
ALTER TABLE tenant_embed_configs DROP COLUMN IF EXISTS "publicKey";
ALTER TABLE tenant_embed_configs ADD COLUMN IF NOT EXISTS "secretHash" TEXT;
ALTER TABLE tenant_embed_configs ADD COLUMN IF NOT EXISTS "secretPrefix" TEXT;
ALTER TABLE tenant_embed_configs ADD COLUMN IF NOT EXISTS "secretRotatedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_embed_configs_secretHash_key"
  ON tenant_embed_configs("secretHash");
