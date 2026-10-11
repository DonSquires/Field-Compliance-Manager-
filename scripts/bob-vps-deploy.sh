#!/usr/bin/env bash
# Ship the current main to the VPS as a release worktree and rebuild the named services from it.
#
#   scripts/bob-vps-deploy.sh control-plane            # Bob control plane (deploy/bob-control-plane compose)
#   scripts/bob-vps-deploy.sh fcm-api                  # chat lane (docker-compose.full.yml service)
#   scripts/bob-vps-deploy.sh control-plane fcm-api    # both
#
# Every step is verified: the bundle base is the newest release the VPS already has, the release
# worktree must exist and be at the pushed commit before anything is built, and each service's
# health is printed afterwards. A silent fall-through to the stale /root checkout (which shipped an
# old control plane for a minute on 2026-09-26) cannot happen here.
set -euo pipefail

VPS_HOST="${BOB_VPS_HOST:-72.61.123.97}"
SSH_KEY="${BOB_VPS_SSH_KEY:-$HOME/.ssh/codespaces-kvm}"
SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15 "root@$VPS_HOST")

[[ $# -ge 1 ]] || { echo "usage: $0 <control-plane|fcm-api|worker-image> [...]" >&2; exit 2; }
cd "$(git rev-parse --show-toplevel)"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "refusing: uncommitted tracked changes in the working tree" >&2; exit 1
fi
git fetch -q origin
HEAD_SHA="$(git rev-parse HEAD)"
if [[ "$HEAD_SHA" != "$(git rev-parse origin/main)" ]]; then
  echo "refusing: HEAD ($HEAD_SHA) is not origin/main ($(git rev-parse origin/main)); push (or fast-forward) first" >&2; exit 1
fi
SHA="${HEAD_SHA:0:8}"

# Base = the newest release the VPS already has (mtime order, not worktree-list order).
BASE="$("${SSH[@]}" 'ls -t /srv/fcm/releases 2>/dev/null | while read -r d; do (cd /root/field-compliance-manager && git cat-file -e "$d^{commit}" 2>/dev/null) && echo "$d" && break; done')"
[[ -n "$BASE" ]] || { echo "could not find a release commit the VPS has; ship a full bundle by hand" >&2; exit 1; }
if [[ "$BASE" == "$SHA" ]]; then
  echo "release $SHA already on the VPS"
else
  echo "bundle $BASE..$SHA"
  git bundle create "/tmp/bob-$SHA.bundle" "$BASE..refs/remotes/origin/main"
  scp -q -i "$SSH_KEY" -o BatchMode=yes "/tmp/bob-$SHA.bundle" "root@$VPS_HOST:/tmp/bob-$SHA.bundle"
  "${SSH[@]}" "set -euo pipefail
    cd /root/field-compliance-manager
    git fetch -q /tmp/bob-$SHA.bundle refs/remotes/origin/main:refs/bundles/bob-$SHA
    rm -f /tmp/bob-$SHA.bundle
    git cat-file -e $HEAD_SHA^{commit}
    [[ -d /srv/fcm/releases/$SHA ]] || git worktree add -q /srv/fcm/releases/$SHA $HEAD_SHA
    [[ \"\$(git -C /srv/fcm/releases/$SHA rev-parse HEAD)\" == \"$HEAD_SHA\" ]] || { echo 'release worktree is not at the pushed commit' >&2; exit 1; }
    echo \"release ready: \$(git -C /srv/fcm/releases/$SHA log --oneline -1)\""
fi

for target in "$@"; do
  case "$target" in
    control-plane)
      "${SSH[@]}" "set -euo pipefail; cd /srv/fcm/releases/$SHA
        DOCKER_GID=999 docker compose -f deploy/bob-control-plane/docker-compose.yml build -q bob-control-plane
        DOCKER_GID=999 docker compose -f deploy/bob-control-plane/docker-compose.yml rm -sf bob-control-plane >/dev/null
        DOCKER_GID=999 docker compose -f deploy/bob-control-plane/docker-compose.yml up -d --force-recreate bob-control-plane >/dev/null
        for i in \$(seq 1 20); do sleep 2; curl -sf http://172.16.0.1:8091/health >/tmp/cp-health.json && break; done
        node -e 'const h=require(\"/tmp/cp-health.json\"); if (h.autopilot === undefined || !h.modelProviders) { console.error(\"health is missing expected fields - wrong build?\", JSON.stringify(h)); process.exit(1); } console.log(\"control-plane ok:\", JSON.stringify({autopilot:h.autopilot, gpu:h.modelProviders.gpu_workstation, laptopShell:h.laptopShell}))'" ;;
    fcm-api)
      "${SSH[@]}" "set -euo pipefail; cd /srv/fcm/releases/$SHA
        docker compose -p fcm --env-file /opt/fcm/.env -f docker-compose.full.yml build -q fcm-api
        docker compose -p fcm --env-file /opt/fcm/.env -f docker-compose.full.yml up -d --no-deps fcm-api >/dev/null
        T=\$(grep -E '^API_TOKEN=' /opt/fcm/.env | cut -d= -f2-)
        for i in \$(seq 1 20); do sleep 2; curl -sf -H \"Authorization: Bearer \$T\" http://127.0.0.1:3001/api/bob/health >/tmp/api-health.json && break; done
        node -e 'const h=require(\"/tmp/api-health.json\"); console.log(\"fcm-api ok:\", JSON.stringify(h.bob.chains))'" ;;
    worker-image)
      # The VPS prunes unused images daily (cron 03:27 `docker image prune -af --filter until=24h`; the 02:52
      # cleanup also prunes stopped containers), and BuildKit gives a rebuilt image its cached layers' old
      # Created time — so the worker image, used only while a verification runs, vanished on 2026-09-27
      # (docker run exit 125, every verification "failed"). A running keeper container pins it.
      "${SSH[@]}" "set -euo pipefail; cd /srv/fcm/releases/$SHA
        docker build -q -f Dockerfile.worker -t fcm/bob-worker:current . >/dev/null && echo 'worker image built: fcm/bob-worker:current'
        docker rm -f fcm-bob-worker-keeper >/dev/null 2>&1 || true
        docker run -d --restart unless-stopped --name fcm-bob-worker-keeper --network none --memory 64m --cpus 0.05 --read-only --entrypoint sleep fcm/bob-worker:current infinity >/dev/null && echo 'worker image pinned by fcm-bob-worker-keeper'" ;;
    *) echo "unknown target: $target" >&2; exit 2 ;;
  esac
done

# A hand deploy moves the release lane's live pointer too, or its next run re-releases what is
# already live (and plans migrations that were applied by hand).
"${SSH[@]}" "mkdir -p /var/lib/bob/release-lane && printf '%s\n' '$HEAD_SHA' > /var/lib/bob/release-lane/deployed_sha"

# Keep the four newest releases (by mtime); other agents' non-worktree dirs are left alone.
"${SSH[@]}" 'cd /root/field-compliance-manager && for d in $(ls -t /srv/fcm/releases | tail -n +5); do git worktree remove --force "/srv/fcm/releases/$d" 2>/dev/null && echo "pruned release $d" || true; done'
