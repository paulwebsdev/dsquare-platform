#!/usr/bin/env bash
set -euo pipefail

# Safe full-platform restore: loopback PostgreSQL and a fresh dsquare_restore_* DB only.
archive="${1:-}"
target_db="${2:-}"
if [[ -z "$archive" || -z "$target_db" || ! -f "$archive" ]]; then
  echo "Usage: $0 <downloaded-platform-backup.dump> <existing-dsquare_restore_database>" >&2
  exit 2
fi
if [[ ! "$target_db" =~ ^dsquare_restore_[a-z0-9_]{1,40}$ ]]; then
  echo "Refusing target: database name must start with dsquare_restore_." >&2
  exit 2
fi
host="${PGHOST:-127.0.0.1}"
if [[ ! "$host" =~ ^(127\.0\.0\.1|localhost|::1)$ ]]; then
  echo "Refusing non-loopback PGHOST. Restore only into a local isolated PostgreSQL instance." >&2
  exit 2
fi
if [[ -z "${PGUSER:-}" ]]; then
  echo "Set PGUSER to a local restore-only PostgreSQL role." >&2
  exit 2
fi
if [[ -n "${DATABASE_URL:-}" || -n "${DB_BACKUP_URL:-}" || -n "${D_DATABASE_PLATFORM_BACKUP_URL:-}" ]]; then
  echo "Unset application/source database URL variables before restoring." >&2
  exit 2
fi

pg_restore --list "$archive" >/dev/null
relation_count="$(psql -X -A -t -v ON_ERROR_STOP=1 -d "$target_db" -c "
  SELECT count(*)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg_toast%';
")"
if [[ "$relation_count" != "0" ]]; then
  echo "Refusing non-empty target database ($relation_count user relations found)." >&2
  exit 1
fi

pg_restore --single-transaction --exit-on-error --no-owner --no-acl \
  --dbname="$target_db" "$archive"
echo "Restore completed into isolated database: $target_db"
