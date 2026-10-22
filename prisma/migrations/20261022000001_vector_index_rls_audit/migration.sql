-- ClinicMind: what Prisma cannot express in schema.prisma.
--
--  1. pgvector ANN index and trigram search index.
--  2. Row-Level Security policies on every tenant-scoped table. The app sets
--     `app.current_tenant` per transaction; see lib/db.ts for the wrapper and
--     docs/ARCHITECTURE.md §3 for the role model.
--  3. Append-only audit log enforced by a trigger, which applies to every role
--     (RLS policies do not bind the table owner).

CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Indexes --------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "knowledge_embeddings_embedding_idx"
  ON "knowledge_embeddings" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS "patients_fullName_trgm_idx"
  ON "patients" USING gin ("fullName" gin_trgm_ops);

-- 2. Row-Level Security ---------------------------------------------------------

CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT current_setting('app.current_tenant', true) $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'clinics', 'users', 'patients', 'medical_histories', 'medications',
    'appointments', 'visits', 'consultations', 'ai_runs', 'conversations',
    'messages', 'documents', 'timeline_events', 'knowledge_embeddings',
    'audit_logs', 'tenant_embed_configs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = app_current_tenant()) WITH CHECK ("tenantId" = app_current_tenant())',
      t
    );
  END LOOP;
END $$;

-- 3. Append-only audit log ------------------------------------------------------

-- UPDATE is always refused. DELETE is refused unless the transaction has set
-- `app.allow_audit_delete = 'on'` — the explicit opt-in used when a tenant is
-- removed (offboarding, data-subject erasure) and its rows cascade.
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS audit_logs_no_update_delete ON "audit_logs";
CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
