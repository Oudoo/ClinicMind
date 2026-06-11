#!/usr/bin/env bash
# One-command macOS setup for The Grow Engine UAT.
#
#   bash scripts/setup-mac.sh
#
# Idempotent: safe to re-run. Handles Homebrew keg-only PostgreSQL (psql not
# on PATH), pgvector/PostgreSQL version matching, database + role creation,
# .env creation, and an npm install fallback for the known esbuild
# "Unknown system error -88" postinstall failure on some Macs.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

say()  { printf "\n\033[1;32m▶ %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m  ⚠ %s\033[0m\n" "$*"; }
die()  { printf "\033[1;31m✖ %s\033[0m\n" "$*"; exit 1; }

command -v brew >/dev/null || die "Homebrew is required: https://brew.sh"
BREW_PREFIX="$(brew --prefix)"

# ── 1. Match pgvector to a PostgreSQL version ────────────────────────────
say "Checking pgvector + PostgreSQL pairing"
brew list pgvector >/dev/null 2>&1 || brew install pgvector
PGVECTOR_PREFIX="$(brew --prefix pgvector)"
# pgvector's share dir tells us which server version it was built for,
# e.g. share/postgresql@17 — that exact server must run the database.
PG_FORMULA="$(ls "$PGVECTOR_PREFIX/share" 2>/dev/null | grep -m1 '^postgresql' || true)"
[ -n "$PG_FORMULA" ] || die "Could not detect pgvector's PostgreSQL target under $PGVECTOR_PREFIX/share"
echo "  pgvector is built for: $PG_FORMULA"

brew list "$PG_FORMULA" >/dev/null 2>&1 || { say "Installing $PG_FORMULA"; brew install "$PG_FORMULA"; }
PG_BIN="$BREW_PREFIX/opt/$PG_FORMULA/bin"
[ -x "$PG_BIN/psql" ] || die "psql not found at $PG_BIN"

# Stop other brew postgres services to free port 5432, start the right one
for other in postgresql@14 postgresql@15 postgresql@16 postgresql@17 postgresql; do
  if [ "$other" != "$PG_FORMULA" ] && brew services list 2>/dev/null | grep -q "^${other}[[:space:]].*started"; then
    warn "Stopping $other (port 5432 needed by $PG_FORMULA)"
    brew services stop "$other" >/dev/null
  fi
done
brew services list | grep -q "^${PG_FORMULA}[[:space:]].*started" || {
  say "Starting $PG_FORMULA"
  brew services start "$PG_FORMULA" >/dev/null
}
brew services list | grep -q "^redis[[:space:]].*started" || {
  say "Starting redis"
  brew install redis >/dev/null 2>&1 || true
  brew services start redis >/dev/null
}

# Wait for postgres to accept connections
say "Waiting for PostgreSQL on :5432"
for i in $(seq 1 30); do
  "$PG_BIN/pg_isready" -q -h localhost -p 5432 && break
  sleep 1
  [ "$i" = 30 ] && die "PostgreSQL did not come up on :5432"
done

# ── 2. Create role, database, extension (idempotent) ─────────────────────
say "Creating database role + database"
PSQL="$PG_BIN/psql -h localhost -p 5432 -d postgres -v ON_ERROR_STOP=1"
$PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='growengine'" | grep -q 1 ||
  $PSQL -c "CREATE USER growengine WITH PASSWORD 'growengine_dev' CREATEDB;"
$PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='growengine'" | grep -q 1 ||
  $PSQL -c "CREATE DATABASE growengine OWNER growengine;"
"$PG_BIN/psql" -h localhost -p 5432 -d growengine -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS vector;"
echo "  database 'growengine' ready with pgvector"

# ── 3. .env ───────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  say "Writing .env (local development defaults)"
  cat > .env <<'ENVEOF'
NODE_ENV=development
APP_URL=http://localhost:3000
DATABASE_URL=postgres://growengine:growengine_dev@localhost:5432/growengine
REDIS_URL=redis://localhost:6379
AUTH_SECRET=dev-only-secret-change-in-production-0123456789
CREDENTIAL_ENCRYPTION_KEY=8e9c1f4ab2d34567890abcdef1234567890abcdef1234567890abcdef123456
AI_PRIMARY_PROVIDER=anthropic
ENVEOF
else
  say ".env already exists — keeping it"
fi

# ── 4. npm install (with esbuild postinstall fallback) ───────────────────
say "Installing dependencies"
if ! npm install --no-audit --no-fund; then
  warn "npm install failed (likely the known esbuild postinstall bug on macOS)."
  warn "Retrying with --ignore-scripts — runtime is unaffected; migrate/seed use plain node."
  rm -rf node_modules
  npm install --no-audit --no-fund --ignore-scripts
fi

# ── 5. Build, migrate, seed ───────────────────────────────────────────────
say "Building packages and apps (first build takes a few minutes)"
npm run build

say "Applying database migrations"
npm run db:migrate

say "Seeding the demo workspace"
npm run db:seed

say "Done! Start the platform with:"
cat <<'NEXTEOF'

    npm run start:web      (terminal tab 1 — http://localhost:3000)
    npm run start:worker   (terminal tab 2 — background workers)

  or both at once:

    npx npm-run-all --parallel start:web start:worker

  Logins (workspace: demo-agency)
    team admin:    admin@demo.growengine.app  / DemoAdmin2026!
    client portal: client@acme-outdoor.com    / DemoClient2026!
NEXTEOF
