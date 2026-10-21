# Bob VPS Human QA

The VPS is the default CPU runner for the full Playwright human suite. RunPod
remains available as scale-to-zero overflow capacity and for future GPU visual
analysis.

## Shipping a release (control plane / fcm-api / worker image)

From a clean checkout that is at `origin/main`:

```bash
scripts/bob-vps-deploy.sh control-plane          # or: fcm-api, worker-image, or several
```

It bundles `main` on top of the newest release the VPS already has, adds a
release worktree under `/srv/fcm/releases/<sha>`, verifies the worktree is at
the pushed commit **before** building anything, rebuilds only the named
services, checks their health (and that the health shape is the current one),
and prunes releases older than the newest four. Never build from
`/root/field-compliance-manager` directly: it lags and once shipped a stale
control plane when a hand-typed deploy chain fell through (2026-09-26).

## Storage hygiene

`scripts/bob-vps-deploy.sh host-hygiene` installs the repo-managed host scripts
from `deploy/bob-vps/host/`:

- `fcm-gitea-backup` (cron 03:23) dumps the legacy Gitea mirror, keeps the
  newest `GITEA_BACKUP_KEEP` (default 3) dumps, retires older ones only after a
  new dump completes, and skips a dump that free space cannot hold with
  headroom. Incident 2026-10-16: the previous 14-day age rule kept fifteen
  ~18 GB dumps (202 GB) and pushed the 388 GB disk to 89%.
- `vps-disk-cleanup.sh` (cron 02:52) prunes stopped containers, images and build
  cache older than 24 h, unused volumes, journals older than 7 days, Gitea dump
  backlog, human-test run evidence older than `HUMAN_TEST_RETENTION_DAYS`
  (default 14), and Bob temp files older than 2 days. It writes
  `/var/lib/bob/storage-hygiene.json`.

Bob's control-plane `/health` reports `storage` (live disk `used_pct`,
`available_gb`, `status` ok/warn/critical at 80/90%, and the last hygiene
receipt), so Bob sees disk pressure before it blocks a build. Application
evidence (`/opt/fcm/vision-derived`), model volumes, Gitea data and Builder
workspaces are never removed by these scripts; Builder detached snapshots are
already capped by `builder-branch-workspace.js`.

## Configure

```bash
sudo install -d -o bob -g bob /srv/fcm/source /srv/fcm/artifacts
cp deploy/bob-vps/human-qa.env.example /srv/fcm/.env
chmod 600 /srv/fcm/.env
```

Dr Bob live and fixture-then-live human testing also requires these values in
the control-plane environment:

```text
HUMAN_TEST_BASE_URL=https://www.fcmanager.co.nz
GRANDMASTER_TEST_EMAIL=<dedicated test identity>
GRANDMASTER_TEST_PASSWORD=<dedicated test identity secret>
VERCEL_TOKEN=<server-side deployment viewer token>
VERCEL_PROJECT_ID=<approved FCM web project id>
VERCEL_TEAM_ID=<optional owning team id>
```

They are passed only to the isolated live QA process, never to browser
JavaScript, prompts, reports, or command arguments. A suite run binds the source
checkout, Vercel deployment, and live test to one expected GitHub SHA.

Populate `BOB_RUNNER_TOKEN` directly on the VPS. Do not commit the populated
file or place user credentials in it.

The deployed VPS control plane is exposed through Docker's host bridge at
`172.16.0.1:8091`; `127.0.0.1:8091` belongs to another service on this host.
Public access (`https://bob.fcmanager.co.nz`, nginx site
`/etc/nginx/sites-enabled/bob.fcmanager.co.nz`) is an allowlist: `/health`,
`/api/bob/builder/atlas/refresh`, `/api/bob/builder/repository/head`, and
`/api/bob/builder/jobs/<id>/(advance|run|workspace|commit|publish|pull-request|context)`.
A new control-plane route must be added to that `location ~` regex (test with
`nginx -t`, then `systemctl reload nginx`; keep backups outside `sites-enabled/`).

### Vibe Builder (owner ruling 2026-10-21)

The web Builder page is now a chat-to-code workspace that bypasses the
`onspace-ai-chat` edge function. The browser writes turns through the
grand-master-only RPCs in `builder_vibe_sessions` / `builder_vibe_messages`;
the control plane (`builder-vibe-session.js`) claims them, edits one live
`bob/vibe-<id8>` branch per session under `$BOB_BUILDER_WORKSPACE_ROOT/vibe/`,
streams every step back via Realtime, commits each turn, and on **Ship** pushes
the branch and opens a pull request. Optional per-session Vite previews
(`builder-vibe-preview.js`, ports 5310+) are served at
`https://bob.fcmanager.co.nz/vibe/<session-id>/` behind a one-time ticket that
sets an HMAC cookie (derived from `BOB_ADMIN_TOKEN`). The preview talks to the
live Supabase project with the public anon key only.

Environment (in `/var/lib/bob/control-plane.env`):
`BOB_VIBE_SUPABASE_ANON_KEY` (public anon key, required for previews),
`BOB_VIBE_ENABLED=0` to switch the worker off, and optional
`BOB_VIBE_TURNS` (40), `BOB_VIBE_BUDGET_MS` (1200000), `BOB_VIBE_MAX_PREVIEWS`
(2), `BOB_VIBE_FRAME_ANCESTORS`. The nginx site has a `/vibe/<uuid>/` location
with websocket upgrade for Vite HMR; install it from
`deploy/bob-vps/nginx/bob.fcmanager.co.nz`, run `nginx -t`, then reload.

The agentic Builder lane needs, in `/var/lib/bob/control-plane.env`:
`OPENAI_API_KEY`, `BOB_OPENAI_MODELS=gpt-5.4-mini,gpt-5.4,gpt-5.1-codex-mini,gpt-5.4-nano`,
`BOB_BUILDER_MODEL=gpt-5.4-mini`, `BOB_BUILDER_REASONING_EFFORT=medium`,
`BOB_BUILDER_REVIEWER_MODEL=gpt-5.4` (owner ruling 2026-09-27: cheaper but
effective — the author makes 30–60 calls per job, the reviewer one, so the mini
tier authors and the full tier reviews; `gpt-6-sol` at `xhigh` emptied the
account in an afternoon). Builder routing is separate from Bob's conversational lane.
Owner ruling 2026-10-16 (supersedes the strong-first chains): Bob's own compute is
the primary workforce and OpenAI is the paid last resort. Use
`BOB_BUILDER_ROUTE_ANALYSIS=gpu_workstation,ollama,openai`,
`BOB_BUILDER_ROUTE_AUTHOR=gpu_workstation,ollama,openai`, and
`BOB_BUILDER_ROUTE_REVIEW=gpu_workstation,ollama,openai` (also the code default),
`BOB_GPU_MODELS=qwen2.5-coder:7b,qwen2.5-coder:14b,qwen3:8b` (the laptop's ~6 GB
GPU keeps the 7b resident; the 14b is the distinct in-house reviewer; `gpt-oss:20b`
is too slow there) and `BOB_OLLAMA_MODELS=qwen2.5-coder:7b,qwen3-coder:30b,llama3.1:8b`
so the VPS CPU tier starts on a model it can serve. The OpenAI variables above apply
only when both in-house tiers fail. The chat lane follows the same rule: code requests
plan in-house unless `BOB_PLAN_CODE_REQUESTS_FAST=true`.
Owner direction 2026-10-18: the owner's Ollama Cloud subscription is the first outsourced
tier, after both in-house tiers and before OpenAI. Set `OLLAMA_API_TOKEN` (never print it) and
optionally `BOB_OLLAMA_CLOUD_MODELS` (see the default below,
the models the current plan serves; `/api/tags` also lists paid-plan models that fail at request
time), `OLLAMA_CLOUD_BASE_URL` (default `https://ollama.com`) and `BOB_OLLAMA_CLOUD_NUM_CTX`.
The default chain is `gpu_workstation,ollama,ollama_cloud,openai`; any `BOB_BUILDER_ROUTE_*`
override must list `ollama_cloud` or it is skipped. Restricted work never leaves local compute.
Owner direction 2026-10-21 (a stronger model, any way that benefits the project): the VPS CPU
tier leaves the unrestricted chains (21-day evidence: 0–3% of analysis/UX runs passed while each
attempt cost 2–7 minutes). The code default and the live env are now
`BOB_BUILDER_ROUTE_ANALYSIS|AUTHOR|REVIEW=gpu_workstation,ollama_cloud,openai`, and the cloud
allowlist default is `gpt-oss:120b,deepseek-v4-pro:0813,nemotron-3-ultra,kimi-k2.7-code,kimi-k3,mistral-large-4,gemma4:31b,gpt-oss:20b`
(Ollama Pro access probed 2026-10-21 and ordered by a replay of a real analyst brief: the first three
returned valid grounded specs, the Kimi and Mistral models could exhaust the 16384-token cap;
qwen3-coder:480b is retired, and glm-5.3/minimax-m3 return empty JSON, so they are excluded). A busy GPU
answers 429 and escalates, so concurrent stages run in parallel across the GPU and Ollama Cloud.
The VPS Ollama keeps restricted-data runs and fcm-api's knowledge-card embeddings
(`POST /api/bob/embed`, plus a backfill every `BOB_EMBED_BACKFILL_INTERVAL_MS`, default 15 min,
batch `BOB_EMBED_BACKFILL_BATCH`, default 25; `0` disables the timer).
`GITEA_USERNAME` + `GITEA_TOKEN` (scopes `write:repository,write:issue,read:user`),
or the GitHub publication credentials used by this deployment. For GitHub
publication, set `BOB_BUILDER_GIT_NAME` and `BOB_BUILDER_GIT_EMAIL` to the
verified name and email (the account's `id+login@users.noreply.github.com` form
is supported). The Builder refuses to create a GitHub commit without the
explicit email, because an unverified author causes Vercel to reject the
preview before the app is built. The worker image `fcm/bob-worker:current`
built as below. Bob autopilot
(`builder-autopilot.js`) runs inside the control plane whenever those are set:
`BOB_BUILDER_AUTOPILOT=false` disables it, `BOB_BUILDER_AUTOPILOT_INTERVAL_MS`
(default 60000) sets the tick, `BOB_BUILDER_REVIEWER_MODEL` picks the
independent reviewer (must differ from `BOB_BUILDER_MODEL`), and
`BOB_BUILDER_MAX_STEP_ATTEMPTS` (default 6) caps retries per step. `/health`
reports `autopilot`, `autopilotIntervalMs`, and `runningBuilderJobs`. The compose file
mounts the docker socket (`group_add` = the host `docker` gid) and translates
`/data` → `/var/lib/bob` for worker bind mounts.

Build the worker image from the checked-out commit (both the control plane's
Builder workers and the human-QA runner use `fcm/bob-worker:current`). Never
re-tag the built image as `mcr.microsoft.com/playwright:*`: that aliases the
Dockerfile's base to a non-root image and the next build fails in `apt-get`
(`docker pull mcr.microsoft.com/playwright:v1.62.1-jammy` restores it).

```bash
docker build -f Dockerfile.worker -t fcm/bob-worker:current .
```

For each approved human-QA lease, set `BOB_JOB_ID` in the VPS environment and
run the existing one-shot runner:

```bash
set -a
. /srv/fcm/.env
set +a
export BOB_JOB_ID=<approved-job-id>
npm run runner
```

The runner uses the fixed `human-qa` profile, a read-only source mount, no
network access, a non-root container user, bounded CPU/memory/PID resources,
and writes evidence to `BOB_ARTIFACT_DIR`.

For the exhaustive page acceptance pass, set `BOB_WORKER_PROFILE=full-page-audit`
before running the same approved job. This profile runs root contracts, CSS
selector contracts, frontend typecheck/tests/build, and the Dr. Bob human suite
that inventories every visible control and follows each safe button from a
fresh route state. It writes Playwright screenshots, traces, HTML reports, and
the command results into the job artifact directory. Write/destructive controls
are recorded and skipped unless a governed test explicitly permits them.
Set `BOB_WORKER_TIMEOUT_MS=3600000` for this profile; the full control walk is
deliberately long and produces one observation artifact per visited control.

For an approved live deployment check, use `BOB_WORKER_PROFILE=human-qa-live`.
That profile enables Docker bridge networking only for the explicit live run;
fixture-backed `human-qa` remains network-isolated.