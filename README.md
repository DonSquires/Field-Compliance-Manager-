# Field Compliance Manager

Backend and deployment workspace for the Field Compliance Manager project.

**Before editing shared code (schema, hooks, shared components), read [AGENTS.md](AGENTS.md) first** — it explains how to query the live Atlas terrain map (`bob_capability_map`/`bob_app_map_edges`) alongside `supabase/schema.sql` to check blast radius before touching anything that isn't purely local to one page.

## Architecture

Read the canonical product and governance model in [FCM_PLATFORM_ARCHITECTURE_BRIEF.md](docs/FCM_PLATFORM_ARCHITECTURE_BRIEF.md) before changing shared domains, UI workflows, Bob behavior, or schema ownership.

GitHub `DonSquires/Field-Compliance-Manager-` on `main` is the authoritative source and Vercel deployment branch for the customer-facing web app. Gitea is a direct downstream mirror used by the VPS-facing Bob development workflow. The VPS contains the Node-based Field Compliance Manager backend, Bob's control plane, a PTT service, and Docker deployment definitions. Supabase provides the database, authentication, storage, row-level security, and workflow data used by the application.

The live public Supabase schema is stored in [`supabase/schema.sql`](supabase/schema.sql). It includes organizations, users, staff, sites, patrols, shifts, dispatch, observations, incidents, enforcement, documents, reporting, and Bob/workflow tables.

## Services

- `bob-control-plane-server.js`: Bob control-plane HTTP service
- `ptt-server/`: push-to-talk service
- `docker-compose.yml`: Bob control plane deployment
- `docker-compose.api.yml`: API and inference image deployment
- `docker-compose.full.yml`: full stack with voice, planner, OSRM, and Ollama
- `deploy/bob-control-plane/docker-compose.yml`: active VPS Bob deployment manifest, using a non-root runtime user
- `deploy/bob-control-plane/deploy.sh`: HPanel/VPS Bob deployment command; fast-forwards the configured Gitea mirror checkout and verifies Bob health
- `.gitea/workflows/runner-test.yml`: private Git runner verification

## Local validation

The production Compose files require environment variables from the VPS and are not safe to start with guessed values. Validate their structure with the required variables supplied locally:

```bash
GITEA_WEBHOOK_SECRET=test BOB_ADMIN_TOKEN=test BOB_ALLOWED_REPOSITORIES=example/app docker compose -f docker-compose.yml config --quiet
npm install
node --check bob-control-plane-server.js
```

The production control plane requires `BOB_ALLOWED_REPOSITORIES` as a comma-separated list of exact Gitea repository names. Copy [`.env.example`](.env.example) to `.env` and replace every placeholder before starting it.

On the protected VPS, keep the production environment at `/var/lib/bob/control-plane.env` with owner `1000:1000` and mode `0600`. Deploy from the HPanel terminal using `bash /root/field-compliance-manager/deploy/bob-control-plane/deploy.sh`. It uses the checkout's configured Gitea remote and performs a fast-forward-only update; set `FCM_GIT_REMOTE` or `FCM_GIT_REF` only when intentionally deploying a different configured remote or ref.

`BOB_WORKFLOW_MODE=local` keeps development jobs in the VPS JSON state file. Set `BOB_WORKFLOW_MODE=remote` only in the protected VPS environment after supplying `SUPABASE_SERVICE_ROLE_KEY`; Bob will then create workflow jobs through the Supabase `wf-create-job` Edge Function. Never expose the service-role key to a browser, worker, or repository.

CCTV frame inference uses the configured RunPod Serverless endpoint first (`RUNPOD_API` and `RUNPOD_API_URL`). The local `fcm-inference` service remains an automatic fallback when RunPod is queued, unavailable, or returns a non-success response. Keep `RUNPOD_API` server-only; never expose it to the web app.

Worker integrations use a separate `BOB_RUNNER_TOKEN` and these routes:

- `POST /jobs/:id/pickup` with `{ "runnerId": "..." }`
- `POST /jobs/:id/artifacts` with `{ "kind": "report", "objectPath": "..." }`

The runner token must not be reused as the human admin token. In remote workflow mode, pickup and artifact calls are forwarded through the existing Supabase workflow Edge Functions.

Bob's first operating mode is read-only assessment. He should map the allowlisted source repositories, Supabase functions and schema, Docker services, deployment metadata, and historical references before proposing implementation work. Assessment can create reports and plans, but it cannot write files, commit, push, change data, or deploy.

The Builder runtime is separate from the legacy generic `/jobs` queue. An authenticated control-plane administrator can create a durable Builder job through `POST /api/bob/builder/jobs`, inspect it through `GET /api/bob/builder/jobs/:id`, advance exactly one verified action through `POST /api/bob/builder/jobs/:id/advance`, or run a bounded sequence through `POST /api/bob/builder/jobs/:id/run`. The bounded runner reloads Supabase state after every specialist action and stops on a human approval, active worker, blocked state, specialist failure, terminal state, or an eight-action ceiling. Source directory, worker image, runner identity, service credentials, and model-gateway credentials come only from protected server configuration, never from the request body.

The platform-tier Admin portal exposes this workflow through the Builder control room. The browser calls only the authenticated `bob-builder-control-room` Edge Function and never receives a control-plane or service-role credential. That function derives the caller and role from Supabase Auth, limits projects and jobs to authorized organizations, creates and reads durable job state directly through scoped service operations, strips artifact locations and model output bodies, and audits each request. Only `advance` and `run` are relayed to the protected VPS because they require repository and worker access. Builder controls are restricted to `master` and `grand_master` roles and remain separate from human approval decisions.

Generate a local read-only inventory with:

```bash
npm run assess -- . bob-artifacts/system-assessment.json
```

The inventory includes Git metadata, source file paths, package scripts/dependencies, Compose service names, and Supabase Edge Function names. It excludes `.env` files, Git metadata contents, `node_modules`, runtime data, and secret values.

The live control plane exposes the same read-only inventory at authenticated `GET /assessment`. It assesses the mounted VPS build and returns sanitized metadata only; it does not create jobs, write files, change Supabase, or deploy.

Coding requires a separate approved job and a fresh isolated writable workspace. Merge and deployment require their own approval gates. See [the backend integration blueprint](docs/backend-integration-blueprint.md) for the boundaries and expected assessment artifacts.

Backend Engineer mode consumes a verified final product specification and only explicitly requested files from a clean, commit-pinned checkout. It can propose bounded changes to Supabase migrations, Edge Functions, shared server code, generated database types, and repository tests. Its deterministic parser requires exact changed-file, migration, and Edge Function manifests plus rollback notes; rejects destructive SQL, dependency/environment changes, and unrelated paths; and marks schema, authorization, storage, and external integration changes as requiring human approval. This mode creates a proposal artifact only. It does not apply migrations, call production APIs, approve, merge, or deploy.

## Worker isolation

[`worker-executor.js`](worker-executor.js) is the host-side worker adapter. It permits only fixed `assessment`, `test`, `build`, `lint`, `frontend-verify`, `backend-verify`, and `security-review` profiles. Each Docker invocation uses a disposable container with no network, a read-only source mount, a separate artifact mount, a non-root UID, dropped capabilities, no-new-privileges, resource limits, and a timeout. The `frontend-verify` profile copies source and locked dependencies into executable disposable tmpfs, validates and applies one bounded `apps/web` patch, then runs fixed lint, build, and test commands. The control-plane HTTP API does not accept shell commands.

Before any Builder specialist works on a requested module, the control plane derives a commit-pinned whole-build map from the clean repository checkout. The map includes the tracked-file inventory, package scripts and dependencies, Compose services, Supabase Edge Functions, public schema entity names, and recent commits; it excludes environment paths, source contents, and raw SQL. Product, UX, frontend, backend, and frontend-repair prompts receive that map before their bounded module-local context. Caller-provided annotations can supplement a task but cannot replace the server-derived build map.

Builder also supplies a fresh read-only context snapshot with aggregate Atlas health (capability and live-edge counts, wiring/exercise state, and refresh timestamps) and aggregate counts for the core operational tables. It never exposes record bodies, PII, credentials, source contents, or raw SQL. The Builder control room displays this evidence in its Context tab. A `grand_master` may request an Atlas refresh there; the authenticated Edge Function relays the request to the protected control plane, which runs the existing guarded `atlas-refresh.js --apply` process. Atlas flow evidence and FK structure remain separate truths and are never presented as interchangeable.

The `backend-verify` profile applies a bounded backend patch only inside disposable tmpfs, rejects destructive SQL and unapproved paths, checks changed JavaScript syntax, and emits a hash-bound changed-file manifest plus `backend-verification.json`. The worker itself records `verification_scope=static_backend_patch` and has no network, Docker socket, Supabase credentials, or production database access. For a patch containing a new additive migration, the host-controlled verifier then starts the pinned Supabase Postgres 17 image with no network or published ports, loads the canonical schema plus every checked-in migration, executes the exact candidate migration, records bounded stage evidence, and always destroys the database. Non-migration patches skip database startup explicitly. A tenant-scoped, commit-pinned, hash-token lease controls the handoff and only service-role RPCs can claim, heartbeat, reset, or finish it. Neither verifier can execute a production migration.

[`Dockerfile.worker`](Dockerfile.worker) builds the worker image with the assessment script, fixed frontend verifier, Git, and the frontend lockfile dependencies. Build it with `docker build -f Dockerfile.worker -t fcm/bob-worker:local .`. Frontend verification emits only `validated.patch`, `changed-files.json`, and redacted `verification.json` alongside the input patch; dependency manifests, environment files, binary patches, symlinks, submodules, traversal paths, and non-frontend files are rejected.

The fixed `security-review` profile independently checks one validated frontend or backend patch, or aggregates one of each into a single digest-bound report. Each scope is validated with its own path and risk policy; duplicate file ownership is rejected. The report never stores matched secret text and blocks progression on critical or high findings such as credential material, protected authentication/routing/access-control changes, dynamic code execution, raw HTML injection, or sensitive browser storage. Backend schema, authorization, storage, and integration risk is preserved as explicit human-approval evidence. Scanner infrastructure failures and expired leases return the review step to a retryable state; policy findings are durable review results and cannot be bypassed as transient failures.

Release preparation consumes only the verified patch, changed-file manifest, build logs, and clean security report. It accepts the bounded frontend or backend implementation scopes and derives schema, authentication, authorization, dependency, environment, and infrastructure impact from those facts; persists separate release notes, rollback plan, and deployment manifest artifacts; and snapshots all seven required artifact types into a human approval. Phase one stops at `release_ready` after approval. No Builder route, worker profile, or database function performs production deployment.

Builder workspaces publish branches and open human-review-only pull requests through the self-hosted Gitea instance. The protected VPS control plane requires `GITEA_BASE_URL`, `GITEA_TOKEN`, `GITEA_OWNER`, and `GITEA_REPO`; it rejects a workspace whose `origin` does not exactly match that configured Gitea repository. GitHub CLI, GitHub pull requests, and GitHub deployment APIs are not runtime dependencies of the application or Builder workflow.

Code review is an explicit per-job intake policy: `none`, `human`, or `independent_ai`. It is optional in addition to, never instead of, the mandatory deterministic security review and final human release approval. Human review uses an authenticated, organization-scoped decision over the exact verified evidence set. Independent AI review uses a different provider or model identity from the model that authored the exact reviewed patch, has no approval/merge/deployment authority, binds its inputs and output artifact to the job and target commit, and may only recommend `passed` or `blocked`. Infrastructure failure retries once; a second failure blocks the selected review policy rather than silently bypassing it.

[`bob-runner.js`](bob-runner.js) is the dedicated runner entrypoint. It picks up one job, invokes a fixed worker profile, writes a sanitized result artifact, and reports the artifact metadata. Run it with `npm run runner` after setting `BOB_JOB_ID`, `BOB_RUNNER_TOKEN`, `BOB_WORKER_IMAGE`, and `BOB_SOURCE_DIR`. The runner should run as a dedicated non-root VPS account with access only to its workspace and artifact directory.

Do not commit `.env` files, database passwords, access tokens, runtime `bob-data`, or Supabase CLI temporary metadata.

## Supabase schema refresh

`supabase/schema.sql` is the ground truth the Atlas playbook in [AGENTS.md](AGENTS.md) cross-checks against, so it must reflect the live database, not a hand-edited hybrid. Two supported ways to refresh it:

1. Full dump (needs the database password):

```bash
npx supabase login
npx supabase link --project-ref dotczcyyzgabmtmnglqj
npx supabase db dump --linked --schema public --file supabase/schema.sql
```

2. Live-catalog snapshot via the Management API (needs only a personal access token; what this Codespace uses):

```bash
SUPABASE_ACCESS_TOKEN="$FIELD_COMPLIANCE_CODESPACE" node scripts/schema-snapshot-live.mjs
```

It reads `pg_catalog` read-only and writes the same quoted dialect as `db dump` (tables, constraints, indexes, views, functions with grants/revokes, triggers, RLS policies, comments), excluding extension-owned objects. Never append migration text to `schema.sql` by hand — regenerate it.

The VPS source was imported separately from Supabase. Supabase stores the application data and services, not the original application source.

GitLab read access for Bob and Codespaces is intentionally separate from the application repository. Follow [the GitLab access setup](docs/gitlab-bob-codespace-setup.md) for project-scoped read-only credentials; never place those credentials in this repository.
