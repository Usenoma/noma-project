#!/usr/bin/env bash
# Daily NOMA database backup (pg_dump -Fc) with 7-day rotation.
# Installed on the build server as /home/ubuntu/noma/backup-db.sh via crontab (15 3 * * *).
set -euo pipefail
umask 077
DIR=${NOMA_BACKUP_DIR:-/home/ubuntu/noma-backups}
mkdir -p "$DIR"
chmod 700 "$DIR"
docker exec noma-postgres-1 pg_dump -U noma -Fc -d noma > "$DIR/noma-$(date +%Y%m%d-%H%M%S).dump"
find "$DIR" -name 'noma-*.dump' -mtime +7 -delete
