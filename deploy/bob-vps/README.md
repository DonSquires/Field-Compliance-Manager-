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

The agentic Builder lane needs, in `/var/lib/bob/control-plane.env`:
`OPENAI_API_KEY`, `BOB_OPENAI_MODELS=gpt-5.4-mini,gpt-5.4,gpt-5.1-codex-mini,gpt-5.4-nano`,
`BOB_BUILDER_MODEL=gpt-5.4-mini`, `BOB_BUILDER_REASONING_EFFORT=medium`,
`BOB_BUILDER_REVIEWER_MODEL=gpt-5.4` (owner ruling 2026-09-27: cheaper but
effective — the author makes 30–60 calls per job, the reviewer one, so the mini
tier authors and the full tier reviews; `gpt-6-sol` at `xhigh` emptied the
account in an afternoon). Builder routing is separate from Bob's conversational lane. Use
`BOB_BUILDER_ROUTE_ANALYSIS=openai,gpu_workstation`,
`BOB_BUILDER_ROUTE_AUTHOR=openai,gpu_workstation`, and
`BOB_BUILDER_ROUTE_REVIEW=openai,gpu_workstation`. The VPS CPU is reserved for
`BOB_BUILDER_ROUTE_LOCAL` and `BOB_BUILDER_ROUTE_RESTRICTED`; it must not make a
simple unrestricted build wait through a long CPU timeout before escalation.
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