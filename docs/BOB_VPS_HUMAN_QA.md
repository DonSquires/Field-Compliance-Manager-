# Bob VPS Human QA Worker

The full human/visual browser suite runs through Bob's existing VPS worker
executor. It does not replace the builder worker, the control plane, or RunPod.

## Responsibilities

- GitHub Actions: bounded CI smoke suite.
- Bob VPS: full Playwright human/visual suite and evidence artifacts.
- RunPod: model/inference workloads only.

RunPod may be enabled as a separate scale-to-zero overflow/visual-analysis
worker using `runpod-qa-worker/`. It is optional and must not be treated as the
inference endpoint. See that worker's README for the signed job contract and
deployment boundary.

## Worker profile

The `human-qa` profile uses the existing `Dockerfile.worker` Playwright image:

```bash
BOB_WORKER_PROFILE=human-qa
BOB_WORKER_IMAGE=mcr.microsoft.com/playwright:v1.62.1-jammy
```

The worker:

- runs the full `apps/web` Playwright matrix;
- uses fixture-backed tests by default, so it needs no external network;
- keeps the source bind mount read-only;
- keeps Docker network access disabled;
- writes screenshots, traces, JSON reports, and the HTML report to `/artifacts`;
- returns through the existing Bob lease/artifact API;
- is bounded by the existing worker timeout, memory, CPU, and PID limits.

## Job invocation

Create an approved Bob worker job with `profile=human-qa`, an exact repository
commit, and a writable artifact directory. The existing `bob-runner.js` then
picks up the lease and calls `worker-executor.js`; no new daemon or port is
introduced.

For live deployment tests, use a separate approved job with the dedicated test
identity and deployment freshness preflight. Do not put service-role, Vercel,
Codespaces, or user credentials into the browser worker environment.

## Why the split exists

The full suite is intentionally exploratory and produces more evidence than a
merge gate needs. Keeping it on the VPS avoids GitHub Actions minute/time-limit
pressure while preserving the fast smoke gate in `.github/workflows/web-ui-quality.yml`.