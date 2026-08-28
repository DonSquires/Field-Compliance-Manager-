# Backend Integration Blueprint

## Product model

Field Compliance Manager is the operational product for security and field teams. It manages organizations, users, staff, clients, sites, zones, agreements, patrols, shifts, dispatch jobs, observations, incidents, vehicles, enforcement, documents, reports, invoices, welfare, and notifications.

Bob is a separate automation and governance plane. Bob helps analyze requirements, design UX, modify code, run verification, prepare releases, and interact with approved repositories. Bob must not become the operational product API and must not receive unrestricted production or root access.

## Current system inventory

### Supabase

The connected project contains the operational data model, authorization policies, workflow records, and 93 Edge Functions. The Edge Functions cover:

- Product operations: users, organizations, documents, notices, disputes, imports, reports, welfare, dispatch, patrols, and location context
- Bob operations: chat, memory, proposals, repository search, schema inspection, SQL read, Gitea sync, VPS view, Vercel view, PTT view, and self-audit
- Intelligence: image/video perception, parking and vehicle classification, document extraction, address/geofence resolution, and inference
- Workflow: job creation, approvals, runs, artifacts, promotion, rollback, and state events

Supabase is the source of truth for operational records and should become the source of truth for Bob jobs and audit history as well.

### VPS

The VPS hosts the current Node Bob control plane and Docker deployment definitions. It also has plans for API, inference, voice, planner, OSRM, Ollama, and Gitea runner services.

The current Bob server provides:

- `GET /health`
- `POST /webhooks/gitea`
- `POST /jobs`
- `GET /jobs/:id`
- `POST /jobs/:id/approve`
- `POST /jobs/:id/cancel`

It validates HMAC webhook signatures, deduplicates delivery IDs, records an audit list, and enforces a single local state file. These are useful foundations, but the server does not yet launch workers or deploy code.

### Vercel

Vercel is the intended customer-facing frontend deployment. The project dashboard is accessible only through authenticated project access. The current repository contains backend code, not the recovered frontend, so Vercel should remain the frontend deployment target once the Expo/web app is imported or rebuilt.

### Historical application

`FreedomCamp-Manager-App` is the strongest UI reference. It is an Expo/React Native app with camera, GPS, offline sync, plate recognition, patrols, jobs, observations, zones, welfare, and Supabase services. It should inform the frontend contract, not replace the current backend.

## Local-first AI policy

The coding agent should run on the VPS without requiring OpenAI or another external model provider for normal operation. The VPS has 31 GiB RAM, 8 vCPUs, no NVIDIA GPU, and an Ollama container already deployed. The initial local model target should therefore be a quantized coding model sized for CPU inference, starting with a 7B class model and measuring latency before considering a larger model.

Ollama should handle repository analysis, product and UX drafts, code generation, test diagnosis, and security-review proposals. External providers, if retained, must be an explicitly disabled-by-default fallback and must never receive secrets, production data, private credentials, or unrestricted repository context.

This local AI policy does not remove the need for Supabase, Gitea, Vercel, or VPS services as infrastructure. It removes the requirement for an external AI API for Bob's core coding workflow.

### Optional hPanel GPU worker

hPanel GPU instances make a stronger local coding model practical without moving the control plane. The recommended split is:

- CPU VPS: Bob control plane, Gitea, runner coordination, approvals, audit, and deployment adapters
- hPanel GPU instance: Ollama or another local inference server, reachable only through an authenticated private service endpoint
- Supabase: workflow persistence, artifacts, and operational application data

Start with an RTX 4090 (24 GB) for a quantized 7B or 14B coding model. Use an A100 80 GB when a larger model or higher concurrency is justified. B200 instances should be reserved for measured workloads that need their additional memory or throughput because they have materially higher cost exposure. GPU instances should be stopped when not required and must never receive root, hPanel, or production database credentials.

The GPU endpoint must not be public Ollama port `11434` without an authenticated gateway. The runner should send only the approved repository snapshot, task specification, and permitted context, then return sanitized artifacts to the control plane.

## Target request flow

```text
Human operator or approved Gitea event
  -> Bob control plane
  -> authenticated job + policy check
  -> Supabase job/audit records
  -> isolated worker on VPS
  -> artifacts and verification results
  -> human approval gate
  -> narrow deployment adapter
  -> Vercel or approved VPS service
```

## Assessment before implementation

Bob should have a broad **read-only assessment mode** before any coding mode is available. Its purpose is to build an accurate system map and produce a plan, not to change the application.

Assessment mode may read:

- The complete file tree and Git history of explicitly allowlisted repositories
- Supabase schema, Edge Function source, RPC contracts, and non-secret configuration names
- Docker Compose definitions, service health, dependency relationships, and deployment metadata
- Vercel project metadata when authenticated access is configured
- Historical prototypes supplied as read-only references

Assessment mode must not:

- Write to a repository, create commits, push branches, or open merges
- Change Supabase data or schema
- Start a coding worker or pass write credentials to a model
- Read secret values, production customer data, private keys, or unrestricted environment files
- Execute arbitrary shell commands

The assessment output should include a system inventory, product/workflow map, dependency graph, data-flow summary, security boundary review, unknowns, proposed implementation slices, and a list of files or services that would be affected. These become reviewable artifacts attached to a planning job.

Implementation is a separate capability. It requires a new approved job, a fresh isolated workspace with a writable copy, a fixed coding profile, and a human approval tied to the exact repository and commit. Merge and deployment require additional approval gates.

## Highest-priority integration work

1. Add a repository allowlist and action policy. A job must identify an allowed repository, exact ref or commit, requested action, and target environment.
2. Move job, approval, artifact, lease, and audit persistence into Supabase tables or the existing workflow tables. Keep the local JSON file only as a development fallback.
3. Add authenticated role-based callers. Replace the single `adminToken` identity with verified Supabase user identity for human requests and short-lived service credentials for workers.
4. Implement a worker launcher with a disposable non-root workspace, resource limits, timeout, network policy, command allowlist, secret redaction, and no host Docker socket.
5. Implement the state machine from the build plan: requested, queued, leased, running, verifying, completed, approval_required, approved, deploying, deployed, failed, cancelled, and rejected.
6. Persist immutable state-transition events with actor, repository, commit SHA, action, result, and timestamps.
7. Add artifact storage with checksums and retention, then expose only job-scoped artifact access.
8. Add verification adapters for tests, type checks, lint, dependency audit, secret scanning, and frontend build checks.
9. Add deployment adapters for Vercel and the approved VPS services. No endpoint should accept arbitrary shell commands.
10. Connect the recovered frontend to the operational Supabase APIs and expose Bob controls only to authorized administrative users.

## Immediate safe milestone

Before enabling deployments, make one end-to-end build job work with a test repository:

- Create a job from the control plane.
- Admit it through the repository policy.
- Run a disposable worker that only reads the repository and produces a product-analysis artifact.
- Store the artifact and audit events in Supabase.
- Display the result to an authorized human.
- Stop at `approval_required`; do not deploy.

This milestone proves the control plane, worker isolation, persistence, artifacts, and approval boundary without risking production data or deployments.

## Security constraints

- Never import or reuse historical `.env` files.
- Never provide Bob with root credentials, hPanel credentials, production database passwords, or broad Git write access by default.
- Keep Supabase service-role credentials inside Edge Functions or narrowly scoped server services.
- Require exact commit and target binding for deployment approval.
- Treat webhook delivery IDs as idempotency keys.
- Keep Vercel and VPS deployment credentials in their respective secret stores.
