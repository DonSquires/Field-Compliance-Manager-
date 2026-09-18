#!/usr/bin/env bash
# Rebuilds the CCTV vision worker from the checked-out revision and confirms it came back up.
set -euo pipefail

app_dir="${FCM_APP_DIR:-/root/field-compliance-manager}"
git_remote="${FCM_GIT_REMOTE:-origin}"
git_ref="${FCM_GIT_REF:-main}"
compose_file="$app_dir/docker-compose.full.yml"
env_file="/opt/fcm/.env"
service="fcm-vision-watcher"

if [[ ! -d "$app_dir/.git" ]]; then
  echo "Expected a Git checkout at $app_dir" >&2
  exit 1
fi

if [[ ! -f "$env_file" ]]; then
  echo "Missing $env_file. The vision worker reads its protected configuration from it." >&2
  exit 1
fi

git -c safe.directory="$app_dir" -C "$app_dir" fetch --prune "$git_remote" "$git_ref"
git -c safe.directory="$app_dir" -C "$app_dir" merge --ff-only FETCH_HEAD

if [[ ! -f "$compose_file" || ! -f "$app_dir/services/vision/vision_job_watcher.js" ]]; then
  echo "The checked-out source is missing the vision worker deployment files." >&2
  exit 1
fi

deployed_revision="$(git -c safe.directory="$app_dir" -C "$app_dir" rev-parse --short HEAD)"
docker compose -f "$compose_file" build --pull "$service"
docker compose -f "$compose_file" up -d --force-recreate "$service"

for attempt in {1..30}; do
  state="$(docker inspect --format '{{.State.Status}}' "$service" 2>/dev/null || true)"
  if [[ "$state" == "running" ]]; then
    echo "$service is running at revision $deployed_revision"
    docker compose -f "$compose_file" logs --tail 20 "$service"
    exit 0
  fi
  sleep 1
done

docker compose -f "$compose_file" logs --tail 100 "$service" >&2
exit 1
