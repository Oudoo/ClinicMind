#!/bin/sh
# Dump the ClinicMind database (custom format, compressed) and prune old dumps.
# Runs inside the `backup` service of docker-compose.prod.yml, or on a host with
# psql tools: PGPASSWORD=... PGHOST=db ./scripts/backup.sh
set -eu
DIR="${BACKUP_DIR:-/backups}"
HOST="${PGHOST:-db}"
USER="${PGUSER:-clinicmind}"
DB="${PGDATABASE:-clinicmind}"
KEEP="${BACKUP_RETENTION_DAYS:-30}"
mkdir -p "$DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DIR/clinicmind-$STAMP.dump"
pg_dump -h "$HOST" -U "$USER" -d "$DB" -Fc -Z 6 -f "$OUT"
echo "backup written: $OUT ($(du -h "$OUT" | cut -f1))"
find "$DIR" -name 'clinicmind-*.dump' -mtime "+$KEEP" -print -delete | sed 's/^/pruned: /'
