#!/bin/sh
set -eu

cd /opt/mdbase-connect
umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
temporary="backups/.postgres-${stamp}.sql.gz.tmp"
destination="backups/postgres-${stamp}.sql.gz"

mkdir -p backups
docker compose --env-file .env -f compose.yml exec -T postgres \
  pg_dump -U mdbase mdbase_connect | gzip > "$temporary"
mv "$temporary" "$destination"
find backups -type f -name 'postgres-*.sql.gz' -mtime +7 -delete
