#!/bin/sh
# Daily pg_dump into /backups (custom format, restorable with pg_restore), keeping BACKUP_KEEP_DAYS.
# Off-site copy is not done here: sync the backup directory to object storage from the host.
set -eu
while true; do
  f="/backups/noma-$(date -u +%Y%m%dT%H%M%SZ).dump"
  if pg_dump -Fc -f "$f.tmp"; then
    mv "$f.tmp" "$f"
    echo "backup written: $f ($(du -h "$f" | cut -f1))"
  else
    rm -f "$f.tmp"
    echo "backup FAILED" >&2
  fi
  find /backups -name 'noma-*.dump' -mtime +"$BACKUP_KEEP_DAYS" -delete
  sleep "$BACKUP_INTERVAL_SECONDS"
done
