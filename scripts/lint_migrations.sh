#!/usr/bin/env bash
# lint_migrations.sh
# -----------------------------------------------------------------------------
# Enforce the migration filename convention:
#     ^[0-9]{14}_[a-z0-9_]+\.sql$
# i.e. 14-digit UTC timestamp + underscore + snake_case description + ".sql".
#
# Background: spec §5.11 + plan T-104. Filenames drive ordering and identity
# of migrations across environments; drift here breaks `supabase db push`
# and the migration_metadata audit trail.
# -----------------------------------------------------------------------------
set -euo pipefail

MIGRATIONS_DIR="${MIGRATIONS_DIR:-supabase/migrations}"
PATTERN='^[0-9]{14}_[a-z0-9_]+\.sql$'

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "lint_migrations: no migrations directory at '$MIGRATIONS_DIR' (nothing to lint)."
  exit 0
fi

shopt -s nullglob
files=("$MIGRATIONS_DIR"/*.sql)
shopt -u nullglob

if [ ${#files[@]} -eq 0 ]; then
  echo "lint_migrations: no .sql files in '$MIGRATIONS_DIR' (ok)."
  exit 0
fi

fail=0
for path in "${files[@]}"; do
  name="$(basename "$path")"
  if [[ ! "$name" =~ $PATTERN ]]; then
    echo "ERROR: migration filename violates convention: $path"
    echo "       expected: ^[0-9]{14}_[a-z0-9_]+\\.sql\$"
    echo "       example:  20260609123000_create_app_schema.sql"
    fail=1
    # Fail fast on first offender — keeps CI output focused.
    exit 1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "lint_migrations: ${#files[@]} file(s) ok."
fi
