#!/usr/bin/env bash
# Disposable-Postgres oracle run: load supabase/schema.sql, apply candidate migrations, run RLS truth tables.
# Same pinned image and isolation flags as backend-database-verifier.js. The container is always destroyed.
#   scripts/run-rls-oracle.sh <migration.sql>... --oracle <truth-table.sql>...
set -uo pipefail
cd "$(dirname "$0")/.."
IMAGE='public.ecr.aws/supabase/postgres:17.6.1.164'
NAME="fcm-oracle-$$"
LOG="${ORACLE_LOG:-/tmp/fcm-oracle-$$.log}"
: > "$LOG"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

run_sql() { # $1 label, $2 file; returns psql exit code, logs everything, prints errors/oracle lines
  local label="$1" file="$2" out rc
  out=$(mktemp)
  docker exec -i "$NAME" psql -h 127.0.0.1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q < "$file" > "$out" 2>&1
  rc=$?
  { echo "== $label ($file) exit=$rc"; cat "$out"; } >> "$LOG"
  echo "== $label exit=$rc"
  grep -E "ERROR|FATAL|FAIL \[|===" "$out" | head -n 40 || true
  grep -E "NOTICE:  ok   \[" "$out" | sed -E 's/^NOTICE:  //' || true
  rm -f "$out"
  return $rc
}

docker run -d --name "$NAME" --network=none --memory=2g --cpus=2 --pids-limit=256 \
  --security-opt=no-new-privileges:true -e POSTGRES_PASSWORD=disposable-only "$IMAGE" >/dev/null || exit 1
for _ in $(seq 1 120); do
  docker exec "$NAME" pg_isready -h 127.0.0.1 -U supabase_admin -d postgres >/dev/null 2>&1 && break
  sleep 0.5
done

run_sql schema supabase/schema.sql || { echo "schema load failed; see $LOG"; exit 1; }
phase=migration
for f in "$@"; do
  if [[ "$f" == --oracle ]]; then phase=oracle; continue; fi
  run_sql "$phase" "$f" || { echo "$phase failed: $f; see $LOG"; exit 1; }
done
echo "log: $LOG"
