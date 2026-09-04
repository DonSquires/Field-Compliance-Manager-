#!/usr/bin/env bash
set -euo pipefail

app_dir="${FCM_APP_DIR:-/root/field-compliance-manager}"
git_remote="${FCM_GIT_REMOTE:-origin}"
git_ref="${FCM_GIT_REF:-main}"
compose_file="$app_dir/deploy/bob-control-plane/docker-compose.yml"
env_file="/var/lib/bob/control-plane.env"

if [[ ! -d "$app_dir/.git" ]]; then
  echo "Expected a Git checkout at $app_dir" >&2
  exit 1
fi

if [[ ! -f "$env_file" ]]; then
  echo "Missing $env_file. Create it from the protected VPS configuration before deploying." >&2
  exit 1
fi

git -c safe.directory="$app_dir" -C "$app_dir" fetch --prune "$git_remote" "$git_ref"
git -c safe.directory="$app_dir" -C "$app_dir" merge --ff-only FETCH_HEAD

if [[ ! -f "$compose_file" || ! -f "$app_dir/bob-control-plane-server.js" ]]; then
  echo "The checked-out source is missing Bob control-plane deployment files." >&2
  exit 1
fi

runtime_source_dir="/var/lib/bob/control-plane-source"
rm -rf "$runtime_source_dir"
install -d -m 700 -o 1000 -g 1000 "$runtime_source_dir"
tar -C "$app_dir" --exclude='./.git' --exclude='./.env' --exclude='./.env.*' --exclude='./node_modules' -cf - . | tar -C "$runtime_source_dir" -xf -
chown -R 1000:1000 "$runtime_source_dir"

docker compose -f "$compose_file" up -d --force-recreate bob-control-plane
for attempt in {1..30}; do
  if curl --fail --silent --show-error http://172.16.0.1:8091/health; then
    exit 0
  fi
  sleep 1
done

docker compose -f "$compose_file" logs --tail 100 bob-control-plane >&2
exit 1