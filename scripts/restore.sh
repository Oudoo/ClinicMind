#!/bin/sh
# Restore a dump produced by backup.sh into the database (DESTRUCTIVE: replaces data).
#   ./scripts/restore.sh backups/clinicmind-20261022T020000Z.dump
# Rehearse first: ./scripts/restore-drill.sh <same file> restores it into a
# scratch database and checks it row for row, without touching live data.
# Then run `npx prisma migrate deploy` in case the dump predates newer migrations.
set -eu
FILE="${1:?usage: restore.sh <dump-file>}"
HOST="${PGHOST:-db}"
USER="${PGUSER:-clinicmind}"
DB="${PGDATABASE:-clinicmind}"
SUM="${FILE%.dump}.sha256"
if [ -f "$SUM" ]; then
  (cd "$(dirname "$FILE")" && sha256sum -c --status "$(basename "$SUM")") || {
    echo "Refusing to restore: $FILE does not match its checksum ($SUM)." >&2
    exit 1
  }
elif [ "${FORCE:-0}" != "1" ]; then
  echo "Refusing to restore: no checksum next to $FILE. Set FORCE=1 to restore it anyway." >&2
  exit 1
fi
echo "Restoring $FILE into $DB on $HOST — this replaces existing data. Ctrl-C within 5s to abort."
sleep 5
pg_restore -h "$HOST" -U "$USER" -d "$DB" --clean --if-exists --no-owner --no-privileges "$FILE"
echo "restore complete"
