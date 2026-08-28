# Field Compliance Manager

Backend and deployment workspace for the Field Compliance Manager project.

## Architecture

The VPS contains the Node-based Field Compliance Manager backend, Bob's control plane, a PTT service, and Docker deployment definitions. Supabase provides the database, authentication, storage, row-level security, and workflow data used by the application. Gitea is the private Git service used by the in-house Bob development workflow.

The live public Supabase schema is stored in [`supabase/schema.sql`](supabase/schema.sql). It includes organizations, users, staff, sites, patrols, shifts, dispatch, observations, incidents, enforcement, documents, reporting, and Bob/workflow tables.

## Services

- `bob-control-plane-server.js`: Bob control-plane HTTP service
- `ptt-server/`: push-to-talk service
- `docker-compose.yml`: Bob control plane deployment
- `docker-compose.api.yml`: API and inference image deployment
- `docker-compose.full.yml`: full stack with voice, planner, OSRM, and Ollama
- `deploy/bob-control-plane/docker-compose.yml`: active VPS Bob deployment manifest, using a non-root runtime user
- `.gitea/workflows/runner-test.yml`: private Git runner verification

## Local validation

The production Compose files require environment variables from the VPS and are not safe to start with guessed values. Validate their structure with the required variables supplied locally:

```bash
GITEA_WEBHOOK_SECRET=test BOB_ADMIN_TOKEN=test BOB_ALLOWED_REPOSITORIES=example/app docker compose -f docker-compose.yml config --quiet
npm install
node --check bob-control-plane-server.js
```

The production control plane requires `BOB_ALLOWED_REPOSITORIES` as a comma-separated list of exact Gitea repository names. Copy [`.env.example`](.env.example) to `.env` and replace every placeholder before starting it.

`BOB_WORKFLOW_MODE=local` keeps development jobs in the VPS JSON state file. Set `BOB_WORKFLOW_MODE=remote` only in the protected VPS environment after supplying `SUPABASE_SERVICE_ROLE_KEY`; Bob will then create workflow jobs through the Supabase `wf-create-job` Edge Function. Never expose the service-role key to a browser, worker, or repository.

Worker integrations use a separate `BOB_RUNNER_TOKEN` and these routes:

- `POST /jobs/:id/pickup` with `{ "runnerId": "..." }`
- `POST /jobs/:id/artifacts` with `{ "kind": "report", "objectPath": "..." }`

The runner token must not be reused as the human admin token. In remote workflow mode, pickup and artifact calls are forwarded through the existing Supabase workflow Edge Functions.

Bob's first operating mode is read-only assessment. He should map the allowlisted source repositories, Supabase functions and schema, Docker services, deployment metadata, and historical references before proposing implementation work. Assessment can create reports and plans, but it cannot write files, commit, push, change data, or deploy.

Generate a local read-only inventory with:

```bash
npm run assess -- . bob-artifacts/system-assessment.json
```

The inventory includes Git metadata, source file paths, package scripts/dependencies, Compose service names, and Supabase Edge Function names. It excludes `.env` files, Git metadata contents, `node_modules`, runtime data, and secret values.

The live control plane exposes the same read-only inventory at authenticated `GET /assessment`. It assesses the mounted VPS build and returns sanitized metadata only; it does not create jobs, write files, change Supabase, or deploy.

Coding requires a separate approved job and a fresh isolated writable workspace. Merge and deployment require their own approval gates. See [the backend integration blueprint](docs/backend-integration-blueprint.md) for the boundaries and expected assessment artifacts.

## Worker isolation

[`worker-executor.js`](worker-executor.js) is the initial host-side worker adapter. It permits only fixed `assessment`, `test`, `build`, and `lint` profiles. Each Docker invocation uses a disposable container with no network, a read-only source mount, a separate artifact mount, a non-root UID, dropped capabilities, no-new-privileges, resource limits, and a timeout. The control-plane HTTP API does not accept shell commands.

[`Dockerfile.worker`](Dockerfile.worker) builds the minimal assessment worker image. It contains only the read-only inventory script and can be built with `docker build -f Dockerfile.worker -t fcm/bob-assessment-worker:local .`.

[`bob-runner.js`](bob-runner.js) is the dedicated runner entrypoint. It picks up one job, invokes a fixed worker profile, writes a sanitized result artifact, and reports the artifact metadata. Run it with `npm run runner` after setting `BOB_JOB_ID`, `BOB_RUNNER_TOKEN`, `BOB_WORKER_IMAGE`, and `BOB_SOURCE_DIR`. The runner should run as a dedicated non-root VPS account with access only to its workspace and artifact directory.

Do not commit `.env` files, database passwords, access tokens, runtime `bob-data`, or Supabase CLI temporary metadata.

## Supabase schema refresh

After authenticating with the Supabase CLI:

```bash
npx supabase login
npx supabase link --project-ref dotczcyyzgabmtmnglqj
npx supabase db dump --linked --schema public --file supabase/schema.sql
```

The VPS source was imported separately from Supabase. Supabase stores the application data and services, not the original application source.

GitLab read access for Bob and Codespaces is intentionally separate from the application repository. Follow [the GitLab access setup](docs/gitlab-bob-codespace-setup.md) for project-scoped read-only credentials; never place those credentials in this repository.
