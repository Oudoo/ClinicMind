-- The application's own database role.
--
-- The tenant_isolation policies bind every role except superusers, roles with
-- BYPASSRLS and the owner of the tables, which is the role running these
-- migrations. So the app connects as `clinicmind_app` (DATABASE_URL) and keeps
-- the owner for the few paths that work across clinics on purpose
-- (SYSTEM_DATABASE_URL: sign-in, sessions, tokens, the audit writer, jobs,
-- the platform console). See src/lib/db.ts.
--
-- The role is created without a password and cannot sign in until the
-- deployment gives it one: scripts/db-app-role.ts, run after
-- `prisma migrate deploy` with APP_DB_PASSWORD.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicmind_app') THEN
    CREATE ROLE clinicmind_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO clinicmind_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO clinicmind_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO clinicmind_app;

-- Sessions, one-time tokens and sign-in history are read across clinics, by
-- the owner connection only; the migration history is not the app's either.
REVOKE ALL ON "sessions", "auth_tokens", "login_events", "_prisma_migrations" FROM clinicmind_app;

-- Tables and sequences added by later migrations get the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO clinicmind_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO clinicmind_app;
