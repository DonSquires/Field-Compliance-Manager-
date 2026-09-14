# Infrastructure Verification & Endpoints Map

This document records the verified production/staging infrastructure, container topologies, SSH access patterns, and API endpoint maps for the Field Compliance Manager (FCM) platform.

Last Verified: 2026-09-13

---

## 1. VPS Host & SSH Access

- **Host Name**: `srv1601189.hstgr.cloud`
- **IP Address**: `72.61.123.97`
- **Port**: `22`
- **User**: `root`
- **Authentication**: Password authentication via PTY using `GRANDMASTER_TEST_PASSWORD` or `MASTER_TEST_PASSWORD` from environment secrets.

### Verification Command Example (Python PTY)

```python
import pty, os, time, select

def run_vps_cmd(cmd_to_run):
    password = os.environ.get('GRANDMASTER_TEST_PASSWORD', '')
    cmd = f'ssh -o StrictHostKeyChecking=accept-new -p 22 root@72.61.123.97 "{cmd_to_run}"'
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp('sh', ['sh', '-c', cmd])
    else:
        output = b''
        start_time = time.time()
        pwd_sent = False
        while time.time() - start_time < 20:
            r, _, _ = select.select([fd], [], [], 0.5)
            if fd in r:
                try:
                    data = os.read(fd, 1024)
                    if not data: break
                    output += data
                    if b'password:' in output.lower() and not pwd_sent:
                        os.write(fd, (password + '\n').encode())
                        pwd_sent = True
                except OSError:
                    break
        _, status = os.waitpid(pid, 0)
        return output.decode('utf-8', errors='replace')
```

---

## 2. RunPod Serverless AI Inference

- **Endpoint Name**: `fieldops-ai-engine`
- **Endpoint ID**: `katqqnmds1dphs`
- **API Base URL**: `https://api.runpod.ai/v2/katqqnmds1dphs`
- **Health Check URL**: `https://api.runpod.ai/v2/katqqnmds1dphs/health`
- **Authentication**: `Authorization: Bearer <RUNPOD_API>` or `RUNPOD_API_KEY`
- **Health Status**: Verified `HTTP 200 OK` (3 workers ready/idle)
- **Connected Services**: `fcm-vision-watcher`, `fcm-inference`

---

## 3. External NZ Services

### NZSCV (Motor Vehicle Register API)

- **Endpoint URL**: `https://tst.nzscv.co.nz/rest/info/v1/vehicleregistrationinfo`
- **Environment Variable**: `NZSCV_ENDPOINT_URL`
- **Consuming Services**: `fcm-vision-watcher`, `fcm-inference`, `fcm-api`

---

## 4. Bob Control Plane & Automation

- **Container Name**: `bob-control-plane` / `bob-control-plane-local`
- **Internal Host Endpoint**: `http://172.16.0.1:8091/health` (host bridge) / `http://127.0.0.1:8091/health`
- **Health Response**: `{"status": "ok", "service": "bob-control-plane", "activeLease": false}`
- **State Storage**: `/var/lib/bob`
- **Configuration**: `/var/lib/bob/control-plane.env`

---

## 5. Live VPS Container Inventory

| Container Name | Image / Role | Exposed / Internal Ports | Status |
|---|---|---|---|
| `bob-control-plane` | `fcm-control-plane:current` | `172.16.0.1:8091->8080/tcp` | Healthy |
| `bob-control-plane-local` | `fcm-control-plane:current` | `127.0.0.1:8092->8080/tcp` | Healthy |
| `fcm-vision-watcher` | `fcm/fcm-vision-watcher:local` | Internal | Running |
| `fcm-inference` | `fcm/fcm-inference:local` | `127.0.0.1:3002->3000/tcp` | Healthy |
| `fcm-api` | `fcm/fcm-api:local` | `127.0.0.1:3001->3000/tcp` | Running |
| `fcm-voice` | `fcm/fcm-voice:local` | `127.0.0.1:3003->3000/tcp` | Healthy |
| `fcm-planner` | `fcm/fcm-planner:local` | `127.0.0.1:3004->3004/tcp` | Healthy |
| `fcm-solver` | `fcm/fcm-solver:local` | `5001/tcp` | Healthy |
| `speech-router` | `speech-intent-speech-router` | `0.0.0.0:8090->8080/tcp` | Healthy |
| `fieldops-ptt` | `fieldops-voice-ptt-server` | `0.0.0.0:8080->8080/tcp` | Healthy |
| `ollama` | `ollama/ollama:latest` | `11434/tcp` | Healthy |
| `osrm` | `osrm/osrm-backend:latest` | `5000/tcp` | Healthy |
| `gitea` | `gitea/gitea:latest` | `3005->3000/tcp`, `2222->22/tcp` | Running |
| `gitea-runner` | `gitea/act_runner:latest` | Internal | Running |
| `bob-control-room-web` | `nginx:alpine` | `3010->80/tcp` | Running |
| `traefik-4xsx-traefik-1` | `traefik:latest` | Reverse proxy | Running |

---

## 6. Key Secrets & Environment Variable Mapping

| Secret Name | Target / Purpose |
|---|---|
| `GRANDMASTER_TEST_PASSWORD` | Password auth for SSH into VPS `root@72.61.123.97:22` |
| `MASTER_TEST_PASSWORD` | Alternate password auth for VPS SSH |
| `RUNPOD_API` | API Bearer key for RunPod (`katqqnmds1dphs`) |
| `SUPABASE_URL` | Primary Supabase URL (`https://dotczcyyzgabmtmnglqj.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Primary Supabase Service-Role Key (data-plane only; cannot deploy functions) |
| `FIELD_COMPLIANCE_CODESPACE` | Supabase personal access token (`sbp_…`) for the Management API / CLI. Sees both projects (`dotczcyyzgabmtmnglqj`, `kxwjcupuxnnbnzcgmkoi`). Use as `SUPABASE_ACCESS_TOKEN` for `supabase functions deploy` |
| `SUPABASE_ACCESS_KEY` | Stale `sbp_…` token — returns `401 Unauthorized` from the Management API as of 2026-09-14. Do not use |
| `FREEDOM_SUPABASE_URL` | Freedom Supabase URL (`https://kxwjcupuxnnbnzcgmkoi.supabase.co`) |
| `FREEDOM_SUPABASE_SERVICE_ROLE_KEY` | Freedom Supabase Service-Role Key |

### Edge function deploy (from Codespace)

```bash
export SUPABASE_ACCESS_TOKEN="$FIELD_COMPLIANCE_CODESPACE"
npx --yes supabase functions deploy <function-name> --project-ref dotczcyyzgabmtmnglqj --use-api
```

Verify with the Management API (`GET /v1/projects/dotczcyyzgabmtmnglqj/functions/<function-name>`)
— `version` increments and `updated_at` moves on each deploy.

## 7. GitLab source lineage (read-only, via Bob's reader)

The most recent build line lives in GitLab `don-squires1/field-compliance-manager`
(project `83317421`, ref `Main`). No `GITLAB_*` credential exists in the Codespace;
the project token is a Supabase function secret used only inside
`bob-repo-search`. Read it the same way Bob does — sign in as the dedicated
`grand_master` test identity and call the function (verified 2026-09-14):

```bash
node scripts/gitlab-read.mjs search 'filename:*.md path:docs' 100   # blob search (GitLab basic syntax, | = OR)
node scripts/gitlab-read.mjs read docs/ARCHITECTURE.md 1 200         # line window
node scripts/gitlab-read.mjs dump - FOUNDATION.md docs/ACCESS_MODEL.md  # whole files -> $GITLAB_READ_OUT (default /tmp/gitlab-read)
```

Requires `SUPABASE_URL`, `FIELD_COMPLIANCE_CODESPACE` (to fetch the public anon
key), `GRANDMASTER_TEST_EMAIL`, `GRANDMASTER_TEST_PASSWORD`. Secret-looking paths
and lines are excluded/redacted server-side; there is no tree listing, so
enumerate files with `filename:<prefix>*.<ext>` searches (100-hit cap per query).

GitLab-only canonical docs (absent from GitHub): `FOUNDATION.md`,
`docs/ARCHITECTURE.md`, `docs/ORG_SERVICE_MODEL.md`, `docs/ACCESS_DOCTRINE.md`,
`docs/ACCESS_MODEL.md`, `docs/architecture/PLATFORM_ENGINES_AND_MODULE_PROFILE.md`,
`docs/MODULE_INTEGRATION_CONTRACT.md`, `packages/shared/src/moduleManifest.ts`,
`docs/design/GEOFENCE_SYSTEM_REDESIGN.md`, `docs/ALIGNMENT_LEDGER.md`,
`docs/PRODUCT_DESIGN.md`, `docs/ENTERPRISE_READINESS_REVIEW.md`, `docs/STAGING.md`
(13.7k-line watch log; the head is the current state).
