#!/usr/bin/env bash
# Ship the current main to the VPS as a release worktree and rebuild the named services from it.
#
#   scripts/bob-vps-deploy.sh control-plane            # Bob control plane (deploy/bob-control-plane compose)
#   scripts/bob-vps-deploy.sh fcm-api                  # chat lane (docker-compose.full.yml service)
#   scripts/bob-vps-deploy.sh control-plane fcm-api    # both
#   scripts/bob-vps-deploy.sh host-hygiene             # nightly storage clean-up + Gitea backup retention
#
# Every step is verified: the bundle base is the newest release the VPS already has, the release
# worktree must exist and be at the pushed commit before anything is built, and each service's
# health is printed afterwards. A silent fall-through to the stale /root checkout (which shipped an
# old control plane for a minute on 2026-09-26) cannot happen here.
set -euo pipefail

VPS_HOST="${BOB_VPS_HOST:-72.61.123.97}"
SSH_KEY="${BOB_VPS_SSH_KEY:-$HOME/.ssh/codespaces-kvm}"
SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15 "root@$VPS_HOST")

[[ $# -ge 1 ]] || { echo "usage: $0 <control-plane|fcm-api|worker-image|host-hygiene> [...]" >&2; exit 2; }
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

# Recreating the control plane kills the verifier containers and agentic turns it is running ("control
# plane restarted before the verifier reported", 10 frontend attempts in October 2026). Wait for Bob's
# in-flight work to finish; BOB_DEPLOY_FORCE=1 overrides for an emergency fix.
drain_control_plane() {
  local wait_s="${BOB_DEPLOY_DRAIN_SECONDS:-1200}"
  [[ "${BOB_DEPLOY_FORCE:-0}" == "1" ]] && { echo "drain skipped (BOB_DEPLOY_FORCE=1)"; return 0; }
  "${SSH[@]}" "set -euo pipefail
    # Read only the two keys: the env file is docker env-file syntax, not shell (unquoted spaces).
    SUPABASE_URL=\$(grep -E '^SUPABASE_URL=' /var/lib/bob/control-plane.env | head -1 | cut -d= -f2-)
    SUPABASE_SERVICE_ROLE_KEY=\$(grep -E '^SUPABASE_SERVICE_ROLE_KEY=' /var/lib/bob/control-plane.env | head -1 | cut -d= -f2-)
    busy() {
      local w m h
      # A four-hour author session must not disappear behind a two-hour deployment lookback.
      if ! w=\$(curl --max-time 15 -sf \"\${SUPABASE_URL%/}/rest/v1/builder_worker_runs?select=id&status=in.(running,queued)&limit=1\" -H \"apikey: \$SUPABASE_SERVICE_ROLE_KEY\" -H \"Authorization: Bearer \$SUPABASE_SERVICE_ROLE_KEY\" | tr -d ' \\n'); then echo 'cannot verify worker activity; treating as busy' >&2; return 0; fi
      if ! m=\$(curl --max-time 15 -sf \"\${SUPABASE_URL%/}/rest/v1/builder_model_runs?select=id&status=eq.running&limit=1\" -H \"apikey: \$SUPABASE_SERVICE_ROLE_KEY\" -H \"Authorization: Bearer \$SUPABASE_SERVICE_ROLE_KEY\" | tr -d ' \\n'); then echo 'cannot verify model activity; treating as busy' >&2; return 0; fi
      if ! h=\$(curl --max-time 30 -sf http://172.16.0.1:8091/health); then echo 'cannot verify runtime activity; treating as busy' >&2; return 0; fi
      if ! printf '%s' \"\$h\" | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d);process.stdin.on(\"end\",()=>{try{const n=JSON.parse(s).runningBuilderJobs;process.exit(Number.isInteger(n)&&n===0?0:1)}catch{process.exit(1)}})'; then return 0; fi
      [[ \"\$w\" != '[]' || \"\$m\" != '[]' ]]
    }
    deadline=\$(( \$(date +%s) + $wait_s ))
    while busy; do
      if (( \$(date +%s) >= deadline )); then echo 'refusing: Bob still has a verifier or model run in flight; retry later or set BOB_DEPLOY_FORCE=1' >&2; exit 1; fi
      echo 'waiting: Bob has a verifier or model run in flight'; sleep 30
    done
    echo 'drained: no Bob verifier or model run in flight'"
}

for target in "$@"; do
  case "$target" in
    control-plane)
      "${SSH[@]}" "set -euo pipefail; cd /srv/fcm/releases/$SHA
        DOCKER_GID=999 docker compose -f deploy/bob-control-plane/docker-compose.yml build -q bob-control-plane"
      # Build first; otherwise new work can start during the image build after the idle check.
      drain_control_plane
      "${SSH[@]}" "set -euo pipefail; cd /srv/fcm/releases/$SHA
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
    host-hygiene)
      # Host storage policy lives in the repo (deploy/bob-vps/host); the crons call the installed copies.
      "${SSH[@]}" "set -euo pipefail; cd /srv/fcm/releases/$SHA
        bash -n deploy/bob-vps/host/fcm-gitea-backup && bash -n deploy/bob-vps/host/vps-disk-cleanup.sh
        install -m 755 deploy/bob-vps/host/fcm-gitea-backup /usr/local/sbin/fcm-gitea-backup
        install -m 755 deploy/bob-vps/host/vps-disk-cleanup.sh /usr/local/bin/vps-disk-cleanup.sh
        echo \"host hygiene installed: \$(sha256sum /usr/local/sbin/fcm-gitea-backup /usr/local/bin/vps-disk-cleanup.sh | cut -c1-12 | tr '\n' ' ')\"" ;;
    *) echo "unknown target: $target" >&2; exit 2 ;;
  esac
done

# This helper can deploy only a subset of a commit's targets. The governed release
# lane owns the repository-wide pointer and advances it only after every required
# migration, function, service, Atlas refresh, and schema check succeeds.

# Keep the four newest releases (by mtime); other agents' non-worktree dirs are left alone.
"${SSH[@]}" 'cd /root/field-compliance-manager && for d in $(ls -t /srv/fcm/releases | tail -n +5); do git worktree remove --force "/srv/fcm/releases/$d" 2>/dev/null && echo "pruned release $d" || true; done'
