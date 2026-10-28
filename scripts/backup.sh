#!/usr/bin/env bash
# Dump the ClinicMind database (custom format, compressed), record what the
# dump holds, and prune old dumps.
# Runs inside the `backup` service of docker-compose.prod.yml, or on a host with
# the PostgreSQL 16 client tools: PGPASSWORD=... PGHOST=db ./scripts/backup.sh
#
# Next to each clinicmind-<stamp>.dump it writes:
#   clinicmind-<stamp>.manifest  the row count of every table, the latest
#                                migration, and the counts of indexes,
#                                constraints, triggers and row-level security
#                                policies, read in the same snapshot as the
#                                dump, so a restore can be checked exactly
#                                (scripts/restore-drill.sh)
#   clinicmind-<stamp>.sha256    the dump's checksum
set -euo pipefail
DIR="${BACKUP_DIR:-/backups}"
HOST="${PGHOST:-db}"
USER="${PGUSER:-clinicmind}"
DB="${PGDATABASE:-clinicmind}"
KEEP="${BACKUP_RETENTION_DAYS:-30}"
mkdir -p "$DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="$DIR/clinicmind-$STAMP"
OUT="$BASE.dump"

# One read-only transaction holds a snapshot open while pg_dump reads it, then
# counts the rows in that same snapshot.
coproc PSQL { psql -X -q -At -v ON_ERROR_STOP=1 -h "$HOST" -U "$USER" -d "$DB" 2>&1; }
send() { printf '%s\n' "$1" >&"${PSQL[1]}"; }
# Print psql's output up to the next sentinel line.
recv() {
  local line
  while IFS= read -r line <&"${PSQL[0]}"; do
    [ "$line" = "__end__" ] && return 0
    printf '%s\n' "$line"
  done
  return 1
}

send "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"
send "SELECT pg_export_snapshot();"
# Read in this shell: bash does not hand coprocess descriptors to subshells.
SNAPSHOT=""
IFS= read -r SNAPSHOT <&"${PSQL[0]}" || true
if ! [[ "$SNAPSHOT" =~ ^[0-9A-F]+-[0-9A-F]+-[0-9]+$ ]]; then
  echo "backup failed: could not open a snapshot ($SNAPSHOT)" >&2
  exit 1
fi

pg_dump -h "$HOST" -U "$USER" -d "$DB" --snapshot="$SNAPSHOT" -Fc -Z 6 -f "$OUT"

send "SELECT 'database ' || current_database();"
send "SELECT 'taken_at ' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"');"
send "SELECT 'server ' || current_setting('server_version_num');"
send "SELECT 'migration ' || coalesce((SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1), 'none');"
send "SELECT 'extensions ' || string_agg(extname, ',' ORDER BY extname) FROM pg_extension;"
send "SELECT 'indexes ' || count(*) FROM pg_indexes WHERE schemaname = 'public';"
send "SELECT 'constraints ' || count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public';"
send "SELECT 'triggers ' || count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal;"
send "SELECT 'policies ' || count(*) FROM pg_policies WHERE schemaname = 'public';"
send "SELECT format('SELECT %L || '' '' || count(*) FROM public.%I', 'table ' || tablename, tablename) FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename \\gexec"
send "SELECT '__end__';"
{
  echo "# ClinicMind backup manifest (scripts/backup.sh); checked by scripts/restore-drill.sh"
  echo "format 1"
  echo "dump $(basename "$OUT")"
  recv
} > "$BASE.manifest"
send "COMMIT;"
send "\\q"
wait "$PSQL_PID" 2>/dev/null || true

if ! grep -q '^table ' "$BASE.manifest"; then
  echo "backup failed: no table counts in $BASE.manifest" >&2
  exit 1
fi
(cd "$DIR" && sha256sum "$(basename "$OUT")" > "$(basename "$BASE").sha256")

echo "backup written: $OUT ($(du -h "$OUT" | cut -f1), $(grep -c '^table ' "$BASE.manifest") tables)"
find "$DIR" -maxdepth 1 -name 'clinicmind-2*' -mtime "+$KEEP" -print -delete | sed 's/^/pruned: /'
