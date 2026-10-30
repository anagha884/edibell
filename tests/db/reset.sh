#!/usr/bin/env bash
# Recreate the local test database from the shim + every migration.
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=${PGDATABASE_TEST:-edibell_test}
psql -q -c "drop database if exists $DB with (force)" -c "create database $DB"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f tests/db/supabase-shim.sql 2>/dev/null
for f in supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f" >/dev/null; done
echo "migrated $DB"
