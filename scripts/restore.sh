#!/bin/sh
# Restore a dump produced by backup.sh into the database (DESTRUCTIVE: replaces data).
#   ./scripts/restore.sh backups/clinicmind-20261022T020000Z.dump
# Then run `npx prisma migrate deploy` in case the dump predates newer migrations.
set -eu
FILE="${1:?usage: restore.sh <dump-file>}"
HOST="${PGHOST:-db}"
USER="${PGUSER:-clinicmind}"
DB="${PGDATABASE:-clinicmind}"
echo "Restoring $FILE into $DB on $HOST — this replaces existing data. Ctrl-C within 5s to abort."
sleep 5
pg_restore -h "$HOST" -U "$USER" -d "$DB" --clean --if-exists --no-owner --no-privileges "$FILE"
echo "restore complete"
