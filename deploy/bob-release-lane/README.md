# Bob release lane (merge → live)

Owner ruling 2026-09-27: the owner gives guidance and cannot code; Bob does the coding and
nobody is asked to deploy by hand. This lane closes the last gap after a pull request merges.

`scripts/bob-release-lane.sh` runs on the VPS host from a systemd timer every 5 minutes:

1. fetches authoritative GitHub `main` through a pinned deploy key and strict host-key checking (the historical Gitea mirror is fallback only),
2. refuses to proceed unless the fetched `main` head author is exactly
   `DonSquires <squires.don@gmail.com>`, then compares it with the last
   release the lane put live (`/var/lib/bob/release-lane/deployed_sha`;
   bootstrapped from the newest `/srv/fcm/releases/<sha>` worktree),
3. classifies the changed paths into targets — new `supabase/migrations/*.sql`, changed edge
   functions (a `_shared` change fans out to every function that imports it), control plane,
   `fcm-api`, worker image, `cctv-vision` (`services/vision` or `services/fcm-inference`: the
   VPS `fcm-inference` and `fcm-vision-watcher` containers); `apps/web` is left to Vercel,
4. **dry-run** (default): writes the plan to `plan.json` and the log, once per new head;
   **live**: applies migrations (refusing destructive SQL), streaming their JSON request bodies
   rather than passing large SQL as a process argument. A migration transport, database or ledger
   failure stops subsequent migrations and all function/service deployment; it is logged and the
   live pointer stays unchanged. After successful migrations, the lane deploys edge functions,
   rebuilds and restarts services with a health check, rolling a failed service back to the previous release,
5. after applying migrations, snapshots the live catalog. If it no longer matches the committed
   `supabase/schema.sql`, `scripts/bob-catalog-refresh-pr.mjs` commits the regenerated
   `schema.sql` and `src/types/database.ts` (verified identity) on `bob/catalog-<sha8>`, opens a
   pull request with `BOB_GITHUB_ACCESS_TOKEN` and rebase-merges it only if it touches nothing but
   those two generated files. The refresh requires both the configured and generated author and
   committer to be `DonSquires <squires.don@gmail.com>`. Builder publication
   likewise requires the configured identity and actual branch-head author to match exactly.
   Rebase preserves the verified author instead of substituting the GitHub account's
   default email. The owner's merge of the migration is the approval (owner ruling 2026-10-21);
   the next tick re-checks and moves the pointer,
6. records a ledger (`ledger.json`) and a note in Bob's own memory (`bob_self_memory`, kind
   `deployment`) so Bob can tell the owner what went live. An early migration failure is logged
   immediately and does not reach this ledger step. The live pointer only moves when every target
   succeeded, so a partial release is retried next tick, not forgotten.

## Manual PR merges and release identity

Before creating a release-bound commit, set and verify the author:

```bash
git config user.name "DonSquires"
git config user.email "squires.don@gmail.com"
git config commit.gpgsign true
git config --get user.name
git config --get user.email
```

After committing, verify its author and committer:

```bash
git show -s --format='%an <%ae>%n%cn <%ce>' HEAD
```

Once the required checks pass, use a rebase merge for commits bearing that
author, then fetch and verify the actual `main` head:

```bash
gh pr merge <number> --rebase
git fetch origin main
git show -s --format='%an <%ae>' origin/main
```

GitHub squash merges can substitute the account's default author identity:
this blocked the lane after #504 on 2026-11-14. If a wrong-author commit has
already landed, do not rewrite `main` or bypass the identity guard. Merge a
subsequent verified-author commit through a PR, verify the resulting head, and
let the lane retry the complete tree.

The verified author is the exact identity above, not the account's noreply
address. Keep Builder publication, catalog refresh and the hook policy aligned
with it. Codespaces signing may use `GitHub <noreply@github.com>` as the
committer; do not disable signing to substitute a different author.

If the installed lane itself still rejects the approved identity, it cannot
self-update past that guard. After the correction passes checks and merges,
install only the reviewed lane script using the pinned SSH identity, validate
its syntax and let the existing timer retry. Do not bypass the guard, advance
`deployed_sha` manually or force a busy control-plane restart.

## Install (once, on the VPS host)

```bash
mkdir -p /srv/fcm/release-lane /var/lib/bob/release-lane
cp scripts/bob-release-lane.sh /srv/fcm/release-lane/ && chmod 700 /srv/fcm/release-lane/bob-release-lane.sh
install -m 644 scripts/bob-runtime-idle.js /srv/fcm/release-lane/bob-runtime-idle.js
cp deploy/bob-release-lane/bob-release-lane.{service,timer} /etc/systemd/system/
printf 'BOB_RELEASE_MODE=dry-run\nSUPABASE_PROJECT_REF=dotczcyyzgabmtmnglqj\nSUPABASE_ACCESS_TOKEN=<management token>\n' > /var/lib/bob/release-lane.env
chmod 600 /var/lib/bob/release-lane.env
systemctl daemon-reload && systemctl enable --now bob-release-lane.timer
```

The script itself is copied, not symlinked, so a broken commit cannot change the lane that is
about to deploy it. The first reviewed installation is deliberate; after that, a change to the
lane script or its systemd units is a classified `release-lane` target. The current run installs
that reviewed revision for the next timer tick without rewriting its own in-flight process.
Switch to live with `BOB_RELEASE_MODE=live` once the proving series has passed and the dry-run
plans have been read.

Control-plane and `fcm-api` replacement and rollback use the shared `bob-runtime-idle.js` probe,
checked after each image build (including the rollback build) and immediately before recreation; a
busy or unverifiable probe defers, and a deferred rollback is reported as such, never as rolled back.
The probe reads only the server activity credentials, queries running/queued model
and verification receipts, and checks in-process Builder execution. Missing
configuration, failed requests or malformed health responses defer the release.
A generated patch awaiting verification is not proof of idle. The helper is installed alongside the lane and updated
as a `release-lane` target. Never force a restart merely to apply a larger timeout
to a future run.

`cctv-vision` cannot rely on a queue read: a watcher (VPS or laptop) can claim a job a moment later.
After its images build, the lane pauses claims in the database (`pause_cctv_inference_claims`,
honoured by `claim_cctv_inference_job` for every watcher version, expiring after 45 minutes as a
backstop) and waits up to `BOB_RELEASE_CCTV_DRAIN_SECONDS` (default 900) for no `video_motion` job to
be `processing`. A pause that fails, an unreadable queue or work that does not drain defers the
release with claims resumed. The pause is held through replacement, the health check
(`fcm-inference` passes its own healthcheck and the watcher heartbeat is fresh) and any rollback,
then `resume_cctv_inference_claims` releases it; an exit on any path also resumes.

A build failure leaves the running services untouched. A failed `up` is a replacement failure: Compose
may already have replaced part of the target, so it is rolled back like an unhealthy release. Every
rollback rebuilds the previous release first: service images have fixed tags, so `up` alone would
restart the image that just failed. The laptop worker's watcher is not reached by the lane;
`deploy/laptop-worker/update-watcher.ps1` updates it on the laptop.

## What stays with a person

- Merging the pull request (until the self-merge decision is taken).
- Migrations with destructive SQL (the lane refuses them and says so).
- A `main` that does not descend from the live release (force-push or manual rollback).
