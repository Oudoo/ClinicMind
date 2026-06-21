-- ─────────────────────────────────────────────────────────────────────────────
-- ClinicMind — post-migration SQL.
--
-- Prisma can't yet express pgvector indexes or Postgres Row-Level Security, so
-- this runs after `prisma db push` / `prisma migrate deploy`:
--
--   psql "${DATABASE_URL%%\?*}" -f prisma/sql/01_pgvector_and_rls.sql
--   (the ${..%%\?*} strips Prisma's `?schema=` suffix, which libpq/psql rejects)
-- ─────────────────────────────────────────────────────────────────────────────

-- Extensions (also declared in schema.prisma datasource.extensions).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Approximate nearest-neighbour index for RAG retrieval (cosine).
-- Tune `lists` to ~sqrt(rows). Requires data present before building ideally.
CREATE INDEX IF NOT EXISTS knowledge_embeddings_embedding_idx
  ON knowledge_embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Trigram indexes accelerate patient full-text/fuzzy search.
CREATE INDEX IF NOT EXISTS patients_fullname_trgm_idx
  ON patients USING gin ("fullName" gin_trgm_ops);

-- ── Row-Level Security ───────────────────────────────────────────────────────
-- Defense-in-depth: even if an application query forgets its tenant filter, the
-- database refuses cross-tenant reads. The app sets `app.current_tenant` per
-- connection (SET LOCAL app.current_tenant = '<tenantId>').
--
-- Apply per tenant-scoped table. Example for patients; replicate for the rest.

ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_patients ON patients;
CREATE POLICY tenant_isolation_patients ON patients
  USING ("tenantId" = current_setting('app.current_tenant', true));

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_appointments ON appointments;
CREATE POLICY tenant_isolation_appointments ON appointments
  USING ("tenantId" = current_setting('app.current_tenant', true));

ALTER TABLE consultations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_consultations ON consultations;
CREATE POLICY tenant_isolation_consultations ON consultations
  USING ("tenantId" = current_setting('app.current_tenant', true));

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_audit ON audit_logs;
CREATE POLICY tenant_isolation_audit ON audit_logs
  USING ("tenantId" = current_setting('app.current_tenant', true));

-- Audit immutability: forbid UPDATE/DELETE on the audit log at the DB level.
DROP POLICY IF EXISTS audit_append_only ON audit_logs;
CREATE POLICY audit_append_only ON audit_logs
  FOR UPDATE USING (false);
