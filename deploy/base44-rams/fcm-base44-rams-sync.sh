#!/usr/bin/env bash
# Read-only Base44 RAMS (OFO) -> FCM sync runner for the VPS. Secrets are read from root-only files and never printed.
set -uo pipefail
umask 077
STATE=/var/lib/fcm-base44-rams
mkdir -p "$STATE"
exec 9>"$STATE/run.lock"
flock -n 9 || { echo "previous RAMS sync still running; skipped"; exit 0; }
getv() { grep -E "^$1=" /var/lib/bob/control-plane.env | tail -n1 | cut -d= -f2- | sed -E "s/^[\"']//; s/[\"']$//"; }
export SUPABASE_URL="$(getv SUPABASE_URL)"
export SUPABASE_SERVICE_ROLE_KEY="$(getv SUPABASE_SERVICE_ROLE_KEY)"
export BASE44_RAMS_TOKEN_FILE=/var/lib/bob/base44-rams-read-token
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
node /opt/fcm-base44-sync/sync-base44-rams.mjs --apply --report "$STATE/report-$stamp.json" > "$STATE/run-$stamp.log" 2>&1
rc=$?
find "$STATE" -maxdepth 1 \( -name 'report-*.json' -o -name 'run-*.log' \) -mtime +30 -delete
echo "RAMS sync finished rc=$rc report=$STATE/report-$stamp.json"
exit $rc
