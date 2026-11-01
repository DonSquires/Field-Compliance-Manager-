#!/usr/bin/env bash
# Bob's release lane: "merge -> live" without a person at a keyboard (owner ruling 2026-09-27:
# the owner gives guidance, Bob does the coding; nobody is asked to deploy by hand).
#
# Runs on the VPS host from a systemd timer (deploy/bob-release-lane/). Each tick:
#   1. fetches authoritative GitHub main through Bob's pinned deploy key (Gitea is fallback only),
#   2. compares it with the last release this lane put live,
#   3. classifies the changed paths into targets (migrations, edge functions, control plane,
#      fcm-api, worker image; the web app deploys itself through Vercel),
#   4. in `dry-run` mode records the plan and stops; in `live` mode applies each target in a safe
#      order with a health check, rolling a failed service back to the previous release,
#   5. leaves a note in Bob's own memory (bob_self_memory, kind `deployment`) so Bob can tell the
#      owner what went live, and a JSON ledger under $STATE_DIR.
#
# Env file: /var/lib/bob/release-lane.env  (BOB_RELEASE_MODE=dry-run|live, SUPABASE_ACCESS_TOKEN,
# SUPABASE_PROJECT_REF, plus the control-plane env for GITEA_*/SUPABASE_URL/SERVICE_ROLE_KEY).
set -euo pipefail

ENV_FILE="${BOB_RELEASE_ENV:-/var/lib/bob/release-lane.env}"
CP_ENV_FILE="${BOB_CONTROL_PLANE_ENV:-/var/lib/bob/control-plane.env}"
STATE_DIR="${BOB_RELEASE_STATE_DIR:-/var/lib/bob/release-lane}"
REPO_DIR="${BOB_RELEASE_REPO_DIR:-/root/field-compliance-manager}"
RELEASES_DIR="${BOB_RELEASE_RELEASES_DIR:-/srv/fcm/releases}"
MODE="${BOB_RELEASE_MODE:-dry-run}"
# Under systemd root has no HOME, so /root/.gitconfig's safe.directory is never read, and the
# checkout is owned by another user: every git call failed with "dubious ownership" (2026-09-27).
export GIT_CONFIG_COUNT=2 \
  GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$REPO_DIR" \
  GIT_CONFIG_KEY_1=safe.directory GIT_CONFIG_VALUE_1="$RELEASES_DIR/*"

load_env() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  # KEY=value lines only; values may contain '='.
  while IFS= read -r line; do
    [[ "$line" =~ ^[A-Z_][A-Z0-9_]*= ]] || continue
    local key="${line%%=*}" value="${line#*=}"
    [[ -n "$(printenv "$key" || true)" ]] || export "$key=$value"
  done < "$file"
}
load_env "$CP_ENV_FILE"
load_env "$ENV_FILE"
MODE="${BOB_RELEASE_MODE:-$MODE}"

mkdir -p "$STATE_DIR"
LOG="$STATE_DIR/release-lane.log"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG" >&2; }

GITHUB_SSH_KEY="${BOB_RELEASE_GITHUB_SSH_KEY_FILE:-/var/lib/bob/github/bob-fcm-main}"
GITHUB_KNOWN_HOSTS="${BOB_RELEASE_GITHUB_KNOWN_HOSTS_FILE:-/var/lib/bob/github/known_hosts}"
FETCH_ENV=()
FETCH_CONFIG=(-c gc.auto=0)
if [[ -n "${GITHUB_OWNER:-}" && -n "${GITHUB_REPO:-}" && -r "$GITHUB_SSH_KEY" && -s "$GITHUB_KNOWN_HOSTS" ]]; then
  REMOTE_URL="git@github.com:${GITHUB_OWNER}/${GITHUB_REPO}.git"
  FETCH_ENV=(env GIT_SSH_COMMAND="ssh -i $GITHUB_SSH_KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$GITHUB_KNOWN_HOSTS -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=10")
else
  : "${GITEA_BASE_URL:?GITEA_BASE_URL is required when GitHub SSH is unavailable}"
  : "${GITEA_OWNER:?}"
  : "${GITEA_REPO:?}"
  : "${GITEA_TOKEN:?}"
  GITEA_URL="${GITEA_PUBLIC_URL:-$GITEA_BASE_URL}"
  REMOTE_URL="${GITEA_URL%/}/${GITEA_OWNER}/${GITEA_REPO}.git"
  FETCH_CONFIG+=(-c "http.extraheader=Authorization: token ${GITEA_TOKEN}")
fi

# 1. What is main now? Housekeeping is not the lane's job: a stale .git/gc.log from a pruned worktree
# made every fetch's auto-gc exit non-zero for 12 hours and the lane logged "mirror unreachable" each
# time (2026-09-27). Fetch with gc off, and log the real (token-free) reason.
fetch_err="$("${FETCH_ENV[@]}" git -C "$REPO_DIR" "${FETCH_CONFIG[@]}" fetch -q "$REMOTE_URL" "+refs/heads/main:refs/remotes/release-lane/main" 2>&1 >/dev/null)" \
  || {
    safe_fetch_err="$fetch_err"
    [[ -z "${GITEA_TOKEN:-}" ]] || safe_fetch_err="${safe_fetch_err//${GITEA_TOKEN}/<token>}"
    log "fetch failed: $(printf '%s' "$safe_fetch_err" | tr '\n' ' ' | cut -c1-300)"
    exit 0
  }
HEAD_SHA="$(git -C "$REPO_DIR" rev-parse refs/remotes/release-lane/main)"

VERIFIED_GITHUB_NAME="Don Squires"
VERIFIED_GITHUB_EMAIL="256263525+DonSquires@users.noreply.github.com"
verify_main_author() {
  local actual
  actual="$(git -C "$REPO_DIR" show -s --format='%an <%ae>' "$HEAD_SHA")" || {
    log "release refused: could not read main branch-head author"
    return 1
  }
  if [[ "$actual" != "$VERIFIED_GITHUB_NAME <$VERIFIED_GITHUB_EMAIL>" ]]; then
    log "release refused: main branch-head author is not the verified GitHub identity"
    return 1
  fi
}
if ! verify_main_author; then exit 1; fi

# 2. What is live? (bootstrap: the newest release worktree the deploy script left behind)
DEPLOYED_FILE="$STATE_DIR/deployed_sha"
if [[ ! -s "$DEPLOYED_FILE" ]]; then
  newest="$(ls -t "$RELEASES_DIR" 2>/dev/null | head -1 || true)"
  [[ -n "$newest" ]] && git -C "$REPO_DIR" rev-parse --verify -q "${newest}^{commit}" >/dev/null && git -C "$REPO_DIR" rev-parse "${newest}^{commit}" > "$DEPLOYED_FILE"
fi
DEPLOYED_SHA="$(cat "$DEPLOYED_FILE" 2>/dev/null || true)"
if [[ -z "$DEPLOYED_SHA" ]]; then log "no baseline release known; refusing to guess"; exit 0; fi

# 2b. Heal out-of-band nginx drift on every tick. A hand edit repointed bob.fcmanager.co.nz at a
#     legacy host service and every Builder relay returned 404 for a day (2026-10-24); the lane
#     only reinstalled sites when a commit touched them. The reference is the last revision whose
#     sites were installed successfully (nginx_sha), not deployed_sha: a release that installs nginx
#     and then fails a later step must not have its new routes reverted here. A missing or dangling
#     site counts as drift; the drifted state (content, link or absence) is kept for review/rollback.
NGINX_SHA_FILE="$STATE_DIR/nginx_sha"
heal_nginx_drift() {
  [[ "$MODE" == "live" ]] || return 0
  command -v nginx >/dev/null 2>&1 || return 0
  local ref name managed live stamp drift_dir="$STATE_DIR/nginx-drift" healed=() sites="${BOB_RELEASE_NGINX_SITES_DIR:-/etc/nginx/sites-enabled}"
  ref="$(cat "$NGINX_SHA_FILE" 2>/dev/null || true)"
  git -C "$REPO_DIR" rev-parse --verify -q "${ref:-x}^{commit}" >/dev/null || ref="$DEPLOYED_SHA"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  for name in $(git -C "$REPO_DIR" ls-tree --name-only "$ref" deploy/bob-vps/nginx/ 2>/dev/null | xargs -r -n1 basename); do
    live="$sites/$name"
    managed="$(mktemp)"
    git -C "$REPO_DIR" show "$ref:deploy/bob-vps/nginx/$name" > "$managed" 2>/dev/null || { rm -f "$managed"; continue; }
    if [[ ! -e "$live" ]] || ! cmp -s "$managed" "$live"; then
      mkdir -p "$drift_dir"
      rm -f "$drift_dir/$name.restore" "$drift_dir/$name.absent"
      if [[ -L "$live" || -e "$live" ]]; then
        cp -P "$live" "$drift_dir/$name.restore"
        [[ -e "$live" ]] && cp -pL "$live" "$drift_dir/$name.$stamp"
      else
        : > "$drift_dir/$name.absent"
      fi
      rm -f "$live"
      install -m 644 "$managed" "$live" && healed+=("$name")
    fi
    rm -f "$managed"
  done
  [[ ${#healed[@]} -gt 0 ]] || return 0
  if nginx -t >/dev/null 2>&1 && systemctl reload nginx; then
    log "nginx drift healed to ${ref:0:8}: ${healed[*]} (drifted copies in $drift_dir)"
  else
    for name in "${healed[@]}"; do
      rm -f "$sites/$name"
      [[ -L "$drift_dir/$name.restore" || -e "$drift_dir/$name.restore" ]] && cp -P "$drift_dir/$name.restore" "$sites/$name"
    done
    systemctl reload nginx || true
    log "nginx drift detected in ${healed[*]} but the managed site at ${ref:0:8} failed nginx -t; drifted state restored, a person must look"
  fi
  rm -f "$drift_dir"/*.restore "$drift_dir"/*.absent
}
heal_nginx_drift

if [[ "$HEAD_SHA" == "$DEPLOYED_SHA" ]]; then exit 0; fi
if ! git -C "$REPO_DIR" merge-base --is-ancestor "$DEPLOYED_SHA" "$HEAD_SHA"; then
  log "main $HEAD_SHA does not descend from the live release $DEPLOYED_SHA (force-push or rollback?); a person must look"
  exit 0
fi

# 3. Classify.
CHANGED="$(git -C "$REPO_DIR" diff --name-only "$DEPLOYED_SHA" "$HEAD_SHA")"
DEPLOYABLE_CHANGED="$(git -C "$REPO_DIR" diff --name-only --diff-filter=ACMRT "$DEPLOYED_SHA" "$HEAD_SHA")"
NEW_MIGRATIONS="$(git -C "$REPO_DIR" diff --name-only --diff-filter=A "$DEPLOYED_SHA" "$HEAD_SHA" -- 'supabase/migrations/*.sql' | sort || true)"
# Deleted function directories are not deployment candidates. Supabase returns a misleading
# "Entrypoint path does not exist" for them and used to hold the whole release pointer back even
# when the names were already absent remotely (live release 7f2031bf, 2026-10-14).
FUNCTIONS="$(printf '%s\n' "$DEPLOYABLE_CHANGED" | sed -n 's#^supabase/functions/\([^_][^/]*\)/.*#\1#p' | sort -u || true)"
SHARED_CHANGED="$(printf '%s\n' "$DEPLOYABLE_CHANGED" | grep -E '^supabase/functions/_shared/' || true)"
if [[ -n "$SHARED_CHANGED" ]]; then
  # A shared module changed: every function that imports it is affected.
  for shared in $SHARED_CHANGED; do
    base="$(basename "$shared")"
    importers="$(git -C "$REPO_DIR" grep -l -e "_shared/${base}" "$HEAD_SHA" -- 'supabase/functions/*/index.ts' 2>/dev/null | sed -n 's#^[0-9a-f]*:supabase/functions/\([^/]*\)/index.ts#\1#p' || true)"
    FUNCTIONS="$(printf '%s\n%s\n' "$FUNCTIONS" "$importers" | sed '/^$/d' | sort -u)"
  done
fi
has() { printf '%s\n' "$CHANGED" | grep -qE "$1"; }
TARGETS=()
has '^(scripts/bob-release-lane\.sh|scripts/bob-runtime-idle\.js|deploy/bob-release-lane/)' && TARGETS+=(release-lane)
has '^(bob-control-plane-server\.js|builder-[a-z-]+\.js|bob-laptop-shell\.js|worker-executor\.js|supabase-workflow-client\.js|package(-lock)?\.json|Dockerfile|deploy/bob-control-plane/|supabase/functions/_shared/builder-)' && TARGETS+=(control-plane)
has '^services/fcm-api/' && TARGETS+=(fcm-api)
has '^(Dockerfile\.worker|frontend-worker\.js|visual-baseline-worker\.js|builder-visual-baseline\.js|backend-worker\.js|security-worker\.js|worker-executor\.js|builder-verification-outcome\.js|builder-path-policy\.js|builder-data-path-gate\.js|builder-ts-delta-gate\.js|assessment-manifest\.js|apps/web/package(-lock)?\.json)' && TARGETS+=(worker-image)
has '^deploy/bob-vps/nginx/' && TARGETS+=(nginx)
# The CCTV watcher and the inference service it calls (engine v2 sat merged but not running until 2026-11-01
# because no target rebuilt them).
has '^services/(vision|fcm-inference)/' && TARGETS+=(cctv-vision)
WEB_ONLY_NOTE=""; has '^apps/web/' && WEB_ONLY_NOTE="apps/web changed: Vercel deploys it from main on its own"

PLAN="$(node -e '
const [deployed, head, mode, migrations, functions, targets, note] = process.argv.slice(1);
console.log(JSON.stringify({ at: new Date().toISOString(), mode, from: deployed, to: head,
  migrations: migrations.split("\n").filter(Boolean), functions: functions.split("\n").filter(Boolean),
  targets: targets.split(" ").filter(Boolean), note: note || null }));' "$DEPLOYED_SHA" "$HEAD_SHA" "$MODE" "$NEW_MIGRATIONS" "$FUNCTIONS" "${TARGETS[*]:-}" "$WEB_ONLY_NOTE")"
printf '%s\n' "$PLAN" > "$STATE_DIR/plan.json"

if [[ "$MODE" != "live" ]]; then
  PLANNED_FILE="$STATE_DIR/planned_sha"
  if [[ "$(cat "$PLANNED_FILE" 2>/dev/null || true)" != "$HEAD_SHA" ]]; then
    log "dry-run plan for ${HEAD_SHA:0:8}: $PLAN"
    printf '%s\n' "$HEAD_SHA" > "$PLANNED_FILE"
  fi
  exit 0
fi

# 4. Live: apply in a safe order. Data first (migrations are additive by Builder policy), then
#    edge functions, then the VPS services, each with a health check and rollback.
# Restarting the control plane mid-run discards the author's turns; wait for the next tick instead.
require_idle() {
  if ! node "$1"; then
    log "deferred ${HEAD_SHA:0:8}: Bob execution is active or unverifiable; retrying next tick"; exit 0
  fi
}
if printf '%s\n' "${TARGETS[@]:-}" | grep -qE '^(control-plane|fcm-api)$'; then
  require_idle "$(dirname "${BASH_SOURCE[0]}")/bob-runtime-idle.js"
fi
# Replacing the vision watcher mid-job drops the job's lease and repeats its GPU work. A queue read alone cannot
# stop a watcher (VPS or laptop) claiming a job a moment later, so the cctv-vision target pauses claims in the
# database (claim_cctv_inference_job honours the pause), drains processing jobs, and holds the pause through
# replacement, health validation and any rollback (review of #298, 2026-11-01).
CCTV_DRAIN_SECONDS="${BOB_RELEASE_CCTV_DRAIN_SECONDS:-900}"
# Covers the drain, replacement, health check and a rollback build inside the unit's 45-minute limit; it is
# the backstop when the lane dies without resuming.
CCTV_PAUSE_SECONDS=2700
CCTV_CLAIMS_PAUSED=false
cctv_rest() {
  [[ -n "${SUPABASE_URL:-}" && -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]] || return 1
  local path="$1"; shift
  curl -sf --max-time 30 "$@" "${SUPABASE_URL%/}/rest/v1/$path" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
}
# Prints idle, busy or unknown.
cctv_queue_state() {
  local body
  body="$(cctv_rest 'inference_jobs?select=id&domain=eq.video_motion&status=eq.processing&limit=1')" || { echo unknown; return 0; }
  case "$body" in '[]') echo idle ;; '['*) echo busy ;; *) echo unknown ;; esac
}
resume_cctv_claims() {
  $CCTV_CLAIMS_PAUSED || return 0
  if cctv_rest rpc/resume_cctv_inference_claims -X POST -H 'Content-Type: application/json' --data-binary '{"p_holder":"release-lane"}' >/dev/null; then
    CCTV_CLAIMS_PAUSED=false; log "CCTV inference claims resumed"
  else
    log "CCTV inference claims could not be resumed; the pause expires on its own within ${CCTV_PAUSE_SECONDS}s"
  fi
}
# Returns only with claims paused and nothing processing; otherwise defers the release (claims resume on exit).
drain_cctv() {
  local waited=0 state
  # Marked before the call: a pause that committed but timed out on the way back is still resumed.
  CCTV_CLAIMS_PAUSED=true
  trap resume_cctv_claims EXIT
  if ! cctv_rest rpc/pause_cctv_inference_claims -X POST -H 'Content-Type: application/json' \
      --data-binary "{\"p_holder\":\"release-lane\",\"p_reason\":\"release ${HEAD_SHA:0:8} is replacing the CCTV watcher and inference service\",\"p_seconds\":${CCTV_PAUSE_SECONDS}}" >/dev/null; then
    log "deferred ${HEAD_SHA:0:8}: CCTV inference claims could not be paused; retrying next tick"; exit 0
  fi
  while state="$(cctv_queue_state)"; [[ "$state" != idle ]]; do
    if [[ "$state" == unknown ]]; then
      log "deferred ${HEAD_SHA:0:8}: the CCTV inference queue is unreadable; retrying next tick"; exit 0
    fi
    if (( waited >= CCTV_DRAIN_SECONDS )); then
      log "deferred ${HEAD_SHA:0:8}: a CCTV inference job is still processing after ${CCTV_DRAIN_SECONDS}s; retrying next tick"; exit 0
    fi
    sleep 15; waited=$((waited + 15))
  done
}
# Healthy = the inference container passes its own healthcheck and the watcher's heartbeat file is fresh.
# watcher_healthcheck.js is not used here: it stops a watcher whose heartbeat is not written yet.
cctv_vision_healthy() {
  local _
  for _ in $(seq 1 40); do
    sleep 3
    [[ "$(docker inspect -f '{{.State.Health.Status}}' fcm-inference 2>/dev/null)" == healthy ]] || continue
    if docker exec fcm-vision-watcher node -e "process.exit(Date.now() - require('fs').statSync('/tmp/fcm-vision-watcher-health').mtimeMs < 90000 ? 0 : 1)" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}
SHA8="${HEAD_SHA:0:8}"
PREVIOUS_RELEASE="$RELEASES_DIR/${DEPLOYED_SHA:0:8}"
RESULTS=()
fail_note() { RESULTS+=("$1"); log "$1"; }

if [[ ! -d "$RELEASES_DIR/$SHA8" ]]; then
  git -C "$REPO_DIR" worktree add -q "$RELEASES_DIR/$SHA8" "$HEAD_SHA"
fi
[[ "$(git -C "$RELEASES_DIR/$SHA8" rev-parse HEAD)" == "$HEAD_SHA" ]] || { log "release worktree is not at $HEAD_SHA"; exit 1; }
cd "$RELEASES_DIR/$SHA8"

supabase_cli() {
  local version platform
  version="$(node -p "require('./package-lock.json').packages['node_modules/supabase'].version")" || return 1
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9.-]+)?$ ]] || { printf '%s\n' 'Supabase CLI version is missing or invalid in package-lock.json' >&2; return 1; }
  platform="$(node -p 'process.platform + "-" + process.arch')" || return 1
  # Explicitly include the native package: the host's unpinned npx cache lacked
  # it and every edge deployment/ledger repair failed before reaching Supabase.
  npx --yes --package="supabase@$version" --package="@supabase/cli-$platform@$version" supabase "$@"
}

OK=true
if [[ -n "$NEW_MIGRATIONS" ]]; then
  : "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN is required for migrations}"; : "${SUPABASE_PROJECT_REF:?}"
  for file in $NEW_MIGRATIONS; do
    version="$(basename "$file" | cut -d_ -f1)"
    # Already in the live ledger (applied by hand or by another agent): re-running it is the risk, not the fix.
    recorded="$(curl -s -X POST "https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query" \
      -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" -H 'Content-Type: application/json' \
      --data-binary "{\"query\":\"select version from supabase_migrations.schema_migrations where version = '${version}'\"}" | tr -d ' \n')"
    if [[ "$recorded" == *"\"version\":\"${version}\""* ]]; then RESULTS+=("migration $version already applied, skipped"); continue; fi
    if grep -qiE '^\s*(drop\s+(table|schema|database|column)|truncate\s+table|alter\s+table[^;]*\bdrop\b|delete\s+from\s+\S+\s*;)' "$file"; then
      fail_note "migration $file contains destructive SQL; not applied automatically"; OK=false; continue
    fi
    body="$(node -e 'process.stdout.write(JSON.stringify({ query: require("fs").readFileSync(process.argv[1], "utf8") }))' "$file")"
    code="$(curl -s -o "$STATE_DIR/migration-$version.out" -w '%{http_code}' -X POST "https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query" \
      -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" -H 'Content-Type: application/json' --data-binary "$body")"
    if [[ "$code" =~ ^2 ]]; then
      if SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" supabase_cli migration repair --status applied "$version" --project-ref "$SUPABASE_PROJECT_REF" --yes >"$STATE_DIR/migration-$version-repair.out" 2>"$STATE_DIR/migration-$version-repair.err"; then
        RESULTS+=("migration $version applied and ledgered")
      else
        fail_note "migration $version applied but ledger repair failed: $(tail -c 300 "$STATE_DIR/migration-$version-repair.err")"
        OK=false
      fi
    else
      fail_note "migration $version failed (HTTP $code): $(head -c 300 "$STATE_DIR/migration-$version.out")"; OK=false
    fi
  done
fi

if [[ -n "$FUNCTIONS" ]]; then
  : "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN is required for edge functions}"; : "${SUPABASE_PROJECT_REF:?}"
  for fn in $FUNCTIONS; do
    if SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" supabase_cli functions deploy "$fn" --project-ref "$SUPABASE_PROJECT_REF" --use-api >/dev/null 2>"$STATE_DIR/fn-$fn.err"; then
      # A deploy that uploads is not a function that starts: probe it so a BOOT_ERROR fails the release.
      boot_body="$(curl -s --max-time 30 -X POST "https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/$fn" -H 'Content-Type: application/json' -d '{}' || true)"
      if [[ "$boot_body" == *BOOT_ERROR* || "$boot_body" == *WORKER_ERROR* ]]; then
        fail_note "edge function $fn deployed but failed to boot: ${boot_body:0:200}"; OK=false
      else
        RESULTS+=("edge function $fn deployed and booted")
      fi
    else
      fail_note "edge function $fn failed: $(tail -c 300 "$STATE_DIR/fn-$fn.err")"; OK=false
    fi
  done
fi

rollback_build() {
  case "$1" in
    cctv-vision) docker compose -p fcm --env-file /opt/fcm/.env -f docker-compose.full.yml build -q fcm-inference fcm-vision-watcher ;;
    control-plane) DOCKER_GID=999 docker compose -f deploy/bob-control-plane/docker-compose.yml build -q bob-control-plane ;;
    fcm-api) docker compose -p fcm --env-file /opt/fcm/.env -f docker-compose.full.yml build -q fcm-api ;;
  esac
}
rollback_up() {
  case "$1" in
    cctv-vision) docker compose -p fcm --env-file /opt/fcm/.env -f docker-compose.full.yml up -d --no-deps fcm-inference fcm-vision-watcher ;;
    control-plane) DOCKER_GID=999 docker compose -f deploy/bob-control-plane/docker-compose.yml up -d --force-recreate bob-control-plane ;;
    fcm-api) docker compose -p fcm --env-file /opt/fcm/.env -f docker-compose.full.yml up -d --no-deps fcm-api ;;
  esac
}
rollback() {
  local target="$1"
  [[ -d "$PREVIOUS_RELEASE" ]] || { fail_note "$target: no previous release to roll back to"; return; }
  # Every service image has a fixed tag (:local / :current), so a rollback rebuilds the previous release
  # (cached layers) before recreating; `up` alone would restart the image that just failed.
  if ! (cd "$PREVIOUS_RELEASE" && rollback_build "$target" >/dev/null); then
    fail_note "$target rollback to ${DEPLOYED_SHA:0:8} failed: the previous release did not build; the failed release is still running"; return
  fi
  # Work can start during the rollback build, so activity is checked immediately before recreation. The
  # cctv-vision caller holds the CCTV claim pause for the whole rollback instead.
  if [[ "$target" != cctv-vision ]]; then
    if ! node scripts/bob-runtime-idle.js; then
      fail_note "$target rollback deferred: Bob execution became active or unverifiable during the rollback build; the failed release is still running and is retried next tick"; return
    fi
  fi
  if (cd "$PREVIOUS_RELEASE" && rollback_up "$target" >/dev/null); then
    fail_note "$target rolled back to ${DEPLOYED_SHA:0:8}"
  else
    fail_note "$target rollback to ${DEPLOYED_SHA:0:8} failed: the previous release could not be started"
  fi
}

for target in "${TARGETS[@]:-}"; do
  case "$target" in
    release-lane)
      if install -m 700 scripts/bob-release-lane.sh /srv/fcm/release-lane/bob-release-lane.sh \
         && install -m 644 scripts/bob-runtime-idle.js /srv/fcm/release-lane/bob-runtime-idle.js \
         && install -m 644 deploy/bob-release-lane/bob-release-lane.service /etc/systemd/system/bob-release-lane.service \
         && install -m 644 deploy/bob-release-lane/bob-release-lane.timer /etc/systemd/system/bob-release-lane.timer \
         && systemctl daemon-reload \
         && systemctl enable bob-release-lane.timer >/dev/null; then
        RESULTS+=("release lane installed at $SHA8; next timer tick uses this revision")
      else OK=false; fail_note "release lane install failed"; fi ;;
    control-plane)
      if ! DOCKER_GID=999 docker compose -f deploy/bob-control-plane/docker-compose.yml build -q bob-control-plane; then
        OK=false; fail_note "control-plane image build failed; the running service was not touched"
      else
        require_idle scripts/bob-runtime-idle.js
        if DOCKER_GID=999 docker compose -f deploy/bob-control-plane/docker-compose.yml up -d --force-recreate bob-control-plane >/dev/null; then
          healthy=false
          for _ in $(seq 1 20); do sleep 2; if curl -sf http://172.16.0.1:8091/health >"$STATE_DIR/cp-health.json" && node -e 'const h=require(process.argv[1]); process.exit(h.autopilot === undefined || !h.modelProviders ? 1 : 0)' "$STATE_DIR/cp-health.json"; then healthy=true; break; fi; done
          if $healthy; then RESULTS+=("control-plane live at $SHA8"); else OK=false; fail_note "control-plane unhealthy after replacement"; rollback control-plane; fi
        else
          # A failed recreate can leave the old container removed and the new one stopped.
          OK=false; fail_note "control-plane replacement failed"; rollback control-plane
        fi
      fi ;;
    fcm-api)
      if ! docker compose -p fcm --env-file /opt/fcm/.env -f docker-compose.full.yml build -q fcm-api; then
        OK=false; fail_note "fcm-api image build failed; the running service was not touched"
      else
        require_idle scripts/bob-runtime-idle.js
        if docker compose -p fcm --env-file /opt/fcm/.env -f docker-compose.full.yml up -d --no-deps fcm-api >/dev/null; then
          T="$(grep -E '^API_TOKEN=' /opt/fcm/.env | cut -d= -f2-)"; healthy=false
          for _ in $(seq 1 20); do sleep 2; if curl -sf -H "Authorization: Bearer $T" http://127.0.0.1:3001/api/bob/health >/dev/null; then healthy=true; break; fi; done
          if $healthy; then RESULTS+=("fcm-api live at $SHA8"); else OK=false; fail_note "fcm-api unhealthy after replacement"; rollback fcm-api; fi
        else
          OK=false; fail_note "fcm-api replacement failed"; rollback fcm-api
        fi
      fi ;;
    cctv-vision)
      if ! docker compose -p fcm --env-file /opt/fcm/.env -f docker-compose.full.yml build -q fcm-inference fcm-vision-watcher; then
        OK=false; fail_note "cctv-vision image build failed; the running services were not touched"
      else
        drain_cctv
        if ! docker compose -p fcm --env-file /opt/fcm/.env -f docker-compose.full.yml up -d --no-deps fcm-inference fcm-vision-watcher >/dev/null; then
          # Compose may have replaced one service before the other failed: put both back under the same pause.
          OK=false; fail_note "cctv-vision replacement failed"; rollback cctv-vision
        elif cctv_vision_healthy; then
          RESULTS+=("cctv vision watcher and inference live at $SHA8")
        else
          OK=false; fail_note "cctv-vision unhealthy after replacement"; rollback cctv-vision
        fi
        resume_cctv_claims
      fi ;;
    worker-image)
      if docker build -q -f Dockerfile.worker -t fcm/bob-worker:current . >/dev/null; then
        # Pin the image against the VPS's daily image prune (see scripts/bob-vps-deploy.sh).
        docker rm -f fcm-bob-worker-keeper >/dev/null 2>&1 || true
        docker run -d --restart unless-stopped --name fcm-bob-worker-keeper --network none --memory 64m --cpus 0.05 --read-only --entrypoint sleep fcm/bob-worker:current infinity >/dev/null || fail_note "worker image keeper could not be started"
        RESULTS+=("worker image rebuilt at $SHA8")
      else OK=false; fail_note "worker image build failed"; fi ;;
    nginx)
      # The public allowlist in front of the control plane: a relay path missing here is an HTTP 404
      # in Bob's chat (laptop terminal, 2026-09-27). Installed only when nginx accepts the whole config.
      # Backups live outside sites-enabled: nginx includes every file there, so a backup beside the
      # site redefined its limit_req_zone and failed every nginx release (2026-10-21).
      nginx_ok=true
      nginx_backup="$STATE_DIR/nginx-previous"
      rm -rf "$nginx_backup"; mkdir -p "$nginx_backup"
      for site in deploy/bob-vps/nginx/*; do
        [[ -f "$site" ]] || continue
        live="/etc/nginx/sites-enabled/$(basename "$site")"
        [[ -f "$live" ]] && cp -p "$live" "$nginx_backup/$(basename "$site")"
        install -m 644 "$site" "$live" || nginx_ok=false
      done
      if $nginx_ok && nginx -t >/dev/null 2>&1 && systemctl reload nginx; then RESULTS+=("nginx sites installed at $SHA8"); printf '%s\n' "$HEAD_SHA" > "$NGINX_SHA_FILE"
      else
        for site in deploy/bob-vps/nginx/*; do
          b="$nginx_backup/$(basename "$site")"; live="/etc/nginx/sites-enabled/$(basename "$site")"
          if [[ -f "$b" ]]; then cp -p "$b" "$live"; else rm -f "$live"; fi
        done
        systemctl reload nginx || true; OK=false; fail_note "nginx rejected the new site config; previous restored"
      fi ;;
  esac
done

# 5. Refresh the two post-release truth surfaces. Atlas is refreshed after every
# code/schema release. A migration also produces a fresh live-catalog schema
# snapshot and proves that the committed snapshot matches live object truth
# (volatile generation/ledger headers are excluded from the comparison).
if [[ -n "$CHANGED" ]]; then
  if [[ -z "${SUPABASE_URL:-}" || -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
    fail_note "post-release Atlas refresh blocked: server-side Supabase credentials are not configured"; OK=false
  elif node scripts/atlas-refresh.js --apply --upsert-only >"$STATE_DIR/atlas-$SHA8.out" 2>"$STATE_DIR/atlas-$SHA8.err"; then
    RESULTS+=("live Atlas refreshed upsert-only at $SHA8; stale generated evidence retained for reconciliation")
    if node scripts/atlas-exercise-evidence.mjs --apply >"$STATE_DIR/atlas-exercise-$SHA8.out" 2>"$STATE_DIR/atlas-exercise-$SHA8.err"; then
      RESULTS+=("Atlas exercise evidence refreshed at $SHA8")
    else
      fail_note "post-release Atlas exercise evidence failed: $(tail -c 300 "$STATE_DIR/atlas-exercise-$SHA8.err")"; OK=false
    fi
  else
    fail_note "post-release Atlas refresh failed: $(tail -c 300 "$STATE_DIR/atlas-$SHA8.err")"; OK=false
  fi
fi

if [[ -n "$NEW_MIGRATIONS" ]]; then
  : "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN is required for the live schema snapshot}"
  live_schema="$STATE_DIR/schema-$SHA8.sql"
  if SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" node scripts/schema-snapshot-live.mjs --project-ref "$SUPABASE_PROJECT_REF" --out "$live_schema" >"$STATE_DIR/schema-$SHA8.out" 2>"$STATE_DIR/schema-$SHA8.err"; then
    if diff -u <(grep -vE '^-- (project:|applied_migrations:)' supabase/schema.sql) <(grep -vE '^-- (project:|applied_migrations:)' "$live_schema") >"$STATE_DIR/schema-$SHA8.diff"; then
      RESULTS+=("live schema snapshot refreshed and matches the committed catalog at $SHA8")
    else
      # Applied migrations changed the live catalog. Bob commits the regenerated schema.sql and
      # database types as a catalog-only PR and merges it (the migration's merge was the approval).
      # The pointer stays put, so the next tick re-checks against the refreshed main.
      if catalog="$(BOB_CATALOG_REMOTE="${REMOTE_URL:-}" "${FETCH_ENV[@]}" node scripts/bob-catalog-refresh-pr.mjs --repo "$REPO_DIR" --base "$HEAD_SHA" --schema "$live_schema" 2>"$STATE_DIR/catalog-$SHA8.err")"; then
        RESULTS+=("live catalog changed by the migration; catalog refresh ${catalog}; release completes on the next tick")
      else
        fail_note "live schema snapshot differs from committed supabase/schema.sql and the catalog refresh PR failed: $(tail -c 300 "$STATE_DIR/catalog-$SHA8.err")"
      fi
      OK=false
    fi
  else
    fail_note "live schema snapshot refresh failed: $(tail -c 300 "$STATE_DIR/schema-$SHA8.err")"; OK=false
  fi
fi

# 6. Record. The live pointer moves only when everything succeeded, so a partial release is retried
#    (idempotent steps) rather than forgotten.
if $OK; then printf '%s\n' "$HEAD_SHA" > "$DEPLOYED_FILE"; fi
node -e '
const [file, ok, head, results, plan] = process.argv.slice(1);
const fs = require("fs"); const ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
ledger.push({ at: new Date().toISOString(), ok: ok === "true", to: head, results: results.split("\n").filter(Boolean), plan: JSON.parse(plan) });
fs.writeFileSync(file, JSON.stringify(ledger.slice(-200), null, 1));' "$STATE_DIR/ledger.json" "$OK" "$HEAD_SHA" "$(printf '%s\n' "${RESULTS[@]:-}")" "$PLAN"

if [[ -n "${SUPABASE_URL:-}" && -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  summary="$(printf '%s; ' "${RESULTS[@]:-nothing to deploy}")"
  note="$(node -e 'const [ok, head, summary, subject] = process.argv.slice(1); console.log(JSON.stringify({ memory_text: `[release ${head.slice(0,8)}] ${ok === "true" ? "went live" : "PARTLY FAILED"}: ${summary}${subject ? ` Commit: ${subject}` : ""}`.slice(0, 1800), memory_kind: "deployment", content: summary.slice(0, 1800) }))' "$OK" "$HEAD_SHA" "$summary" "$(git -C "$REPO_DIR" log -1 --format=%s "$HEAD_SHA")")"
  curl -s -o /dev/null -X POST "${SUPABASE_URL%/}/rest/v1/bob_self_memory" -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" -H 'Content-Type: application/json' --data-binary "$note" || true
fi
log "release ${SHA8}: ok=$OK ${RESULTS[*]:-}"
$OK
