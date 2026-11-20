# Gitea CI (replaces hosted GitHub Actions)

GitHub remains the source of truth for code, pull requests, branch protection and Vercel
deploys. Verification runs on the self-hosted Gitea Actions runner on the VPS.

```
GitHub (main + open PR heads) --bridge--> Gitea repo --push--> .gitea/workflows/verify.yml on fcm-vps-runner
GitHub commit statuses  <--bridge-- Gitea commit statuses ("PR verification / <job> (push)")
```

- `.gitea/workflows/verify.yml` runs the same jobs and steps as `.github/workflows/verify-pr.yml`
  (`test/gitea-verify-workflow.test.js` fails if they drift). It reads no secrets: any mirrored
  branch runs its own copy of the workflow file.
- `fcm-gitea-ci-bridge.mjs` runs every two minutes from a systemd timer. It mirrors GitHub `main`
  (fast-forward only) and same-repository open PR heads (never forks) into Gitea, then posts
  `gitea-ci / <job>` and an aggregate `gitea-ci` status on the GitHub commit. When `main` passes it
  refreshes the live Atlas on the host (replacing `.github/workflows/atlas-refresh.yml`).
- `scripts/local-ci.mjs` runs the same workflow on a developer machine (`--pr N`) and posts
  `local-ci / <job>` statuses; use it when the VPS runner is busy or unavailable.

## Install or update on the VPS

1. Copy `fcm-gitea-ci-bridge.mjs` to `/srv/fcm/gitea-ci/`.
2. Copy the `.service` and `.timer` units to `/etc/systemd/system/`. Non-secret settings live in
   the unit's `Environment=` lines.
3. Put the two tokens in root-only files (directory mode 700, files mode 600):
   `/etc/fcm-gitea-ci/github-token` (commit-status write and contents read on the GitHub repo) and
   `/etc/fcm-gitea-ci/gitea-token` (`write:repository` on the Gitea repo). systemd hands them to the
   bridge with `LoadCredential=`; they are never exported to git or docker child processes.
4. `systemctl daemon-reload && systemctl enable --now fcm-gitea-ci-bridge.timer`
5. Watch: `journalctl -u fcm-gitea-ci-bridge.service -f`

Runner: `gitea-runner` container (`/opt/gitea-runner/config.yaml`), labels `ubuntu-22.04` /
`ubuntu-latest` on `catthehacker/ubuntu:act-22.04`, host Docker socket mounted for the
disposable PostgreSQL tests.
