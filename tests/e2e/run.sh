#!/usr/bin/env bash
# Fresh e2e database + local Supabase test gateway + browser workflow test.
# Requires: local PostgreSQL (PGHOST/PGPORT/PGUSER), the Vite dev server running
# with .env.local pointing VITE_SUPABASE_URL at http://localhost:54321, and Playwright.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=${1:-e2e-shots}
PGDATABASE_TEST=edibell_e2e bash tests/db/reset.sh
node tests/e2e/local-supabase.mjs & GW=$!
trap 'kill $GW' EXIT
sleep 1
node tests/e2e/workflow.e2e.mjs "${BASE_URL:-http://localhost:3000}" "$OUT"
# Map picker test (Geoapify responses are stubbed). Needs any non-empty
# VITE_GEOAPIFY_API_KEY in .env.local for the dev server.
node tests/e2e/map.e2e.mjs "${BASE_URL:-http://localhost:3000}" "$OUT"
# Footer + Get in Touch form (real database submissions, admin inbox).
node tests/e2e/contact.e2e.mjs "${BASE_URL:-http://localhost:3000}" "$OUT"
# Back arrow + browser history behaviour.
node tests/e2e/navigation.e2e.mjs "${BASE_URL:-http://localhost:3000}" "$OUT"
# Languages: selector, persistence, untranslated-text scan, layout in Kannada/Hindi.
node tests/e2e/i18n.e2e.mjs "${BASE_URL:-http://localhost:3000}" "$OUT"
