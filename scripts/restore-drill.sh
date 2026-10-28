#!/usr/bin/env bash
# Rehearse a restore: load a backup into a scratch database and prove it holds
# exactly what the backup captured. The live database is never touched.
#
#   ./scripts/restore-drill.sh                       # the newest dump in $BACKUP_DIR
#   ./scripts/restore-drill.sh backups/clinicmind-20261028T020000Z.dump
#
# Checks, in order: the dump's checksum; a clean pg_restore (any error fails);
# every table and its row count against the manifest backup.sh wrote in the
# dump's own snapshot; the latest migration; the counts of indexes,
# constraints (the no-double-booking exclusion constraints among them),
# triggers, row-level security policies and the tables under them; the tables
# the application role may read; the extensions; and that the audit log still
# refuses edits. Appends one line to $BACKUP_DIR/restore-drill.log,
# drops the scratch database (KEEP_DRILL_DB=1 keeps it for inspection), and
# exits non-zero on any failure.
set -euo pipefail
DIR="${BACKUP_DIR:-/backups}"
HOST="${PGHOST:-db}"
USER="${PGUSER:-clinicmind}"
LIVE_DB="${PGDATABASE:-clinicmind}"
DRILL_DB="${DRILL_DATABASE:-clinicmind_restore_drill}"
LOG="$DIR/restore-drill.log"
STARTED=$(date +%s)

FILE="${1:-}"
if [ -z "$FILE" ]; then
  FILE="$(ls -1t "$DIR"/clinicmind-*.dump 2>/dev/null | head -n 1 || true)"
fi
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "restore drill: no dump found (looked in $DIR)" >&2
  exit 2
fi
if [ "$DRILL_DB" = "$LIVE_DB" ]; then
  echo "restore drill: DRILL_DATABASE must not be the live database ($LIVE_DB)" >&2
  exit 2
fi
BASE="${FILE%.dump}"
MANIFEST="$BASE.manifest"
SUM="$BASE.sha256"
NAME="$(basename "$FILE")"

q() { PGOPTIONS="-c client_min_messages=warning ${PGOPTIONS:-}" psql -X -q -At -v ON_ERROR_STOP=1 -h "$HOST" -U "$USER" "$@"; }
cleanup() {
  if [ "${KEEP_DRILL_DB:-0}" != "1" ]; then
    q -d postgres -c "DROP DATABASE IF EXISTS \"$DRILL_DB\" WITH (FORCE)" >/dev/null 2>&1 || true
  fi
}
fail() {
  echo "restore drill FAILED: $*" >&2
  mkdir -p "$DIR" && echo "$(date -u +%FT%TZ) FAIL $NAME $*" >> "$LOG"
  cleanup
  exit 1
}
manifest() { grep -m1 "^$1 " "$MANIFEST" | cut -d' ' -f2-; }

[ -f "$MANIFEST" ] || fail "no manifest next to the dump ($MANIFEST)"

# 1. The file is the one the backup wrote.
if [ -f "$SUM" ]; then
  (cd "$(dirname "$FILE")" && sha256sum -c --status "$(basename "$SUM")") || fail "checksum mismatch"
else
  fail "no checksum next to the dump ($SUM)"
fi

# 2. A fresh scratch database, then the restore, grants included (the
#    application role is cluster-wide, not in the dump: it must exist for the
#    grants to it to restore). Any error fails the drill.
q -d postgres -c "DROP DATABASE IF EXISTS \"$DRILL_DB\" WITH (FORCE)" >/dev/null
q -d postgres -c "CREATE DATABASE \"$DRILL_DB\"" >/dev/null
q -d postgres -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicmind_app') THEN CREATE ROLE clinicmind_app NOLOGIN; END IF; END \$\$" >/dev/null
pg_restore -h "$HOST" -U "$USER" -d "$DRILL_DB" --exit-on-error --no-owner "$FILE" \
  || fail "pg_restore stopped with an error"

# 3. Every table, row for row.
tables=0
rows=0
mismatches=()
while read -r _ table expected; do
  actual="$(q -d "$DRILL_DB" -c "SELECT count(*) FROM public.\"$table\"" 2>/dev/null || echo missing)"
  if [ "$actual" != "$expected" ]; then
    mismatches+=("$table: expected $expected, restored $actual")
  fi
  tables=$((tables + 1))
  rows=$((rows + expected))
done < <(grep '^table ' "$MANIFEST")
[ "$tables" -gt 0 ] || fail "the manifest lists no tables"
restored_tables="$(q -d "$DRILL_DB" -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
[ "$restored_tables" = "$tables" ] || mismatches+=("tables: expected $tables, restored $restored_tables")

# 4. Schema objects and the migration history.
check() {
  local label="$1" sql="$2" expected
  expected="$(manifest "$label")"
  local actual
  actual="$(q -d "$DRILL_DB" -c "$sql")"
  [ "$actual" = "$expected" ] || mismatches+=("$label: expected $expected, restored $actual")
}
check migration "SELECT coalesce((SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1), 'none')"
check extensions "SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension"
check indexes "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public'"
check constraints "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'"
check triggers "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal"
check policies "SELECT count(*) FROM pg_policies WHERE schemaname = 'public'"
# Recorded since the application role (older manifests do not have them).
if [ -n "$(manifest rls_tables)" ]; then
  check rls_tables "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity"
  check app_grants "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND has_table_privilege('clinicmind_app', c.oid, 'SELECT')"
fi

# 5. The audit log is still append-only in the restored copy.
if [ "$(q -d "$DRILL_DB" -c "SELECT count(*) > 0 FROM audit_logs")" = "t" ]; then
  if q -d "$DRILL_DB" -c "UPDATE audit_logs SET action = action WHERE id = (SELECT id FROM audit_logs LIMIT 1)" >/dev/null 2>&1; then
    mismatches+=("audit_logs accepted an edit: the append-only trigger is missing")
  fi
fi

if [ "${#mismatches[@]}" -gt 0 ]; then
  printf '  %s\n' "${mismatches[@]}" >&2
  fail "${#mismatches[@]} difference(s): ${mismatches[0]}"
fi

seconds=$(( $(date +%s) - STARTED ))
summary="tables=$tables rows=$rows migration=$(manifest migration) taken_at=$(manifest taken_at) seconds=$seconds"
mkdir -p "$DIR" && echo "$(date -u +%FT%TZ) OK $NAME $summary" >> "$LOG"
echo "restore drill passed: $NAME ($summary)"
cleanup
