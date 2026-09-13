# Bob VPS Human QA

The VPS is the default CPU runner for the full Playwright human suite. RunPod
remains available as scale-to-zero overflow capacity and for future GPU visual
analysis.

## Configure

```bash
sudo install -d -o bob -g bob /srv/fcm/source /srv/fcm/artifacts
cp deploy/bob-vps/human-qa.env.example /srv/fcm/.env
chmod 600 /srv/fcm/.env
```

Populate `BOB_RUNNER_TOKEN` directly on the VPS. Do not commit the populated
file or place user credentials in it.

The deployed VPS control plane is exposed through Docker's host bridge at
`172.16.0.1:8091`; `127.0.0.1:8091` belongs to another service on this host.

Build the worker image from the checked-out commit:

```bash
docker build -f Dockerfile.worker -t mcr.microsoft.com/playwright:v1.62.1-jammy .
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