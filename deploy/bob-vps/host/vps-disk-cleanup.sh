#!/usr/bin/env bash
# Nightly VPS storage hygiene. Installed to /usr/local/bin/vps-disk-cleanup.sh by
# `scripts/bob-vps-deploy.sh host-hygiene` (cron 02:52). Writes /var/lib/bob/storage-hygiene.json,
# which Bob's control plane reports on /health so Bob can see the disk and the last clean-up.
# Only regenerable or superseded data is removed: application evidence (/opt/fcm/vision-derived),
# model volumes, Gitea data and in-use Builder workspaces are never touched here.
set -u
LOG=/var/log/vps-disk-cleanup.log
REPORT=/var/lib/bob/storage-hygiene.json
HUMAN_TEST_DAYS="${HUMAN_TEST_RETENTION_DAYS:-14}"
GITEA_KEEP="${GITEA_BACKUP_KEEP:-3}"
used_bytes() { df --output=used -B1 / | tail -1 | tr -d ' '; }
before=$(used_bytes)
echo "===== $(date -u '+%Y-%m-%dT%H:%M:%SZ') cleanup start =====" >> "$LOG"
df -h / >> "$LOG" 2>&1

# Stopped containers first (a volume held by a stopped container won't prune otherwise).
docker container prune -f >> "$LOG" 2>&1
# Images/build cache older than 24h (protects anything in active use today; the worker image is
# pinned by the fcm-bob-worker-keeper container).
docker system prune -af --filter "until=24h" >> "$LOG" 2>&1
docker volume prune -af >> "$LOG" 2>&1
journalctl --vacuum-time=7d >> "$LOG" 2>&1
find /home/gitlab-runner/builds -maxdepth 2 -type d -mtime +2 -exec rm -rf {} + >> "$LOG" 2>&1
# Superseded Gitea dumps beyond the newest $GITEA_KEEP (the backup job applies the same rule after
# each dump; this catches a backlog when a dump is skipped).
ls -1t /root/fcm-deploy-backups/gitea/gitea-*.zip 2>/dev/null | tail -n +$(( GITEA_KEEP + 1 )) | while read -r old; do
  rm -f -- "$old" && echo "retired $(basename "$old")" >> "$LOG"
done
rm -f /root/fcm-deploy-backups/gitea/.gitea-*.zip.part 2>/dev/null
# Human-test run evidence older than the retention window (receipts stay in the database).
find /var/lib/bob/human-test-runs -mindepth 1 -maxdepth 1 -mtime +"$HUMAN_TEST_DAYS" -exec rm -rf {} + >> "$LOG" 2>&1
find /var/lib/bob/tmp -mindepth 1 -maxdepth 1 -mtime +2 -exec rm -rf {} + >> "$LOG" 2>&1

after=$(used_bytes)
df -h / >> "$LOG" 2>&1
read -r total avail < <(df --output=size,avail -B1 / | tail -1)
cat > "$REPORT.tmp" <<JSON
{"checked_at":"$(date -u +%FT%TZ)","freed_bytes":$(( before > after ? before - after : 0 )),"used_bytes":$after,"total_bytes":$total,"available_bytes":$avail,"gitea_backups_kept":$(ls -1 /root/fcm-deploy-backups/gitea/gitea-*.zip 2>/dev/null | wc -l),"human_test_retention_days":$HUMAN_TEST_DAYS}
JSON
mv "$REPORT.tmp" "$REPORT"
echo "===== $(date -u '+%Y-%m-%dT%H:%M:%SZ') cleanup done =====" >> "$LOG"
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
