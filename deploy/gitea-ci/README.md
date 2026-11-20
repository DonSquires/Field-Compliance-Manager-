# Gitea is the source of truth; GitHub is the deploy mirror

Owner decision (2026-11-21): pull requests, review and CI move to Gitea
(`https://git.fcmanager.co.nz/Iron-Eagle-Security-Ltd/field-compliance-manager`). Hosted GitHub
Actions is unavailable (account spending limit). Vercel still builds production from GitHub
`main`, so GitHub stays as a mirror that only ever fast-forwards to Gitea `main`.

```
branch push ──▶ Gitea PR ──▶ .gitea/workflows/verify.yml on fcm-vps-runner ──▶ rebase merge to Gitea main
                                                                                   │
                     bridge (systemd timer, every 30 s) ◀────────────────────────┘
                       ├─ fast-forward GitHub main ──▶ Vercel production deploy
                       └─ after Gitea CI passes on main: refresh the live Atlas on the host
```

- `.gitea/workflows/verify.yml` runs on every pull request and every push to `main`, with the same
  jobs and steps as `.github/workflows/verify-pr.yml` (`test/gitea-verify-workflow.test.js` fails
  if they drift). It reads no secrets: a pull request runs its own copy of the workflow.
- Gitea `main` protection: no direct pushes, every `PR verification / *` check must pass, and
  rebase is the only merge style so the original (verified) commit author is kept for Vercel.
- `fcm-gitea-ci-bridge.mjs` fast-forwards GitHub `main` to Gitea `main` (never force; a divergence
  is logged and nothing is pushed) and refreshes the live Atlas once all three verification jobs
  pass on Gitea `main` (replacing `.github/workflows/atlas-refresh.yml` without exposing the
  service-role key to branch-controlled workflows).
- GitHub `main` protection allows the mirror's direct push but still forbids force-pushes and
  deletion. Do not open or merge pull requests on GitHub; they would diverge from Gitea.
- `scripts/local-ci.mjs` runs the same workflow on a developer machine
  (`node scripts/local-ci.mjs --ref <branch> --no-status`) when the runner is busy.

## Install or update on the VPS

1. Copy `fcm-gitea-ci-bridge.mjs` to `/srv/fcm/gitea-ci/`.
2. Copy the `.service` and `.timer` units to `/etc/systemd/system/`. Non-secret settings live in
   the unit's `Environment=` lines.
3. Put the two tokens in root-only files (directory mode 700, files mode 600):
   `/etc/fcm-gitea-ci/github-token` (contents write on the GitHub repo) and
   `/etc/fcm-gitea-ci/gitea-token` (read on the Gitea repo). systemd hands them to the bridge with
   `LoadCredential=`; they are never exported to git or docker child processes.
4. `systemctl daemon-reload && systemctl enable --now fcm-gitea-ci-bridge.timer`
5. Watch: `journalctl -u fcm-gitea-ci-bridge.service -f`

Runner: `gitea-runner` container (`/opt/gitea-runner/config.yaml`), one job at a time, labels
`ubuntu-22.04` / `ubuntu-latest` on `catthehacker/ubuntu:act-22.04`, host Docker socket mounted for
the disposable PostgreSQL tests.
