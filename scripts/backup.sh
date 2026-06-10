#!/usr/bin/env bash
# Disaster recovery — daily PostgreSQL dump (+ optional MinIO mirror),
# 30–90 day retention, recorded into backup_records for the ops portal.
#
# Cron example (daily at 02:30):
#   30 2 * * * /var/www/growengine/scripts/backup.sh >> /var/log/growengine-backup.log 2>&1
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
DATABASE_URL="${DATABASE_URL:-$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" | cut -d= -f2-)}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR/postgres"

record() {
  psql "$DATABASE_URL" -q -c \
    "INSERT INTO backup_records (backup_type, storage_key, size_bytes, status, completed_at, expires_at)
     VALUES ('$1', '$2', '$3', '$4', NOW(), NOW() + INTERVAL '$RETENTION_DAYS days');" || true
}

echo "[$STAMP] PostgreSQL backup starting"
PG_FILE="$BACKUP_DIR/postgres/growengine-$STAMP.sql.gz"
if pg_dump "$DATABASE_URL" | gzip > "$PG_FILE"; then
  SIZE=$(stat -c%s "$PG_FILE")
  record postgres "$PG_FILE" "$SIZE" completed
  echo "[$STAMP] PostgreSQL backup OK ($SIZE bytes)"
else
  record postgres "$PG_FILE" "0" failed
  echo "[$STAMP] PostgreSQL backup FAILED" >&2
  exit 1
fi

# Optional: mirror MinIO bucket when mc (MinIO client) is configured
if command -v mc >/dev/null 2>&1 && [ -n "${MINIO_ALIAS:-}" ]; then
  echo "[$STAMP] Object storage mirror starting"
  mkdir -p "$BACKUP_DIR/storage"
  if mc mirror --overwrite "$MINIO_ALIAS/growengine" "$BACKUP_DIR/storage"; then
    record object_storage "$BACKUP_DIR/storage" "$(du -sb "$BACKUP_DIR/storage" | cut -f1)" completed
  else
    record object_storage "$BACKUP_DIR/storage" "0" failed
  fi
fi

# Retention sweep
find "$BACKUP_DIR/postgres" -name '*.sql.gz' -mtime +"$RETENTION_DAYS" -delete
echo "[$STAMP] Done. Backups older than $RETENTION_DAYS days pruned."
