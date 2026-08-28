# Bob Control-Plane Service Contract

**Status:** Design specification - not deployed
**Service role:** Separate automation and governance plane for the Field Compliance Manager platform
**Initial deployment target:** VPS 1601189
**Initial execution policy:** One build job at a time

## 1. Boundary

### Field Compliance Manager API

Owns operational product capabilities:

- Organisations, sites, zones, agreements
- Patrols, compliance records, reports, and business workflows
- Product-user authentication and authorization
- Operational business data

### Bob control-plane

Owns automation and governance capabilities:

- Gitea repository events and repository metadata
- Build job intake, queueing, locking, leasing, and cancellation
- Isolated worker execution
- Build logs and artifacts
- Verification and deployment readiness
- Explicit approval gates
- Narrow deployment adapters
- Append-only control-plane audit events

Bob must not become a second operational product API, and the FCM API must not directly control build or deployment authority.

## 2. Trust boundaries

### Human callers

Authenticated administrative users may create jobs, inspect jobs and artifacts, cancel jobs, and approve deployment-capable actions. Authorization must be role- and action-based; ordinary operational users must not receive Bob control-plane privileges by default.

### Gitea webhooks

Webhook requests must be accepted only after signature validation against a protected secret. The service must capture repository, ref, commit, sender, delivery identifier, and received timestamp. Invalid signatures are rejected and audited without exposing secret-comparison details.

### Internal workers

Workers authenticate service-to-service using a dedicated credential or short-lived job lease token. Workers receive only the job-scoped inputs required for execution and must not receive broad hPanel, root, or human credentials.

### Deployment adapters

Adapters are the only component permitted to invoke deployment actions. The API must not expose arbitrary shell execution. Each adapter accepts a validated deployment request and returns a structured result.

## 3. Initial job state machine

```text
requested -> queued -> leased -> running -> verifying -> completed
                                      |          |
                                      |          +-> failed
                                      +-> failed

queued -> cancelled
requested -> cancelled
completed -> approval_required -> approved -> deploying -> deployed
                                      |             |
                                      +-> rejected  +-> failed
```

### State rules

- `requested`: job accepted but not yet admitted to the queue.
- `queued`: waiting for the single available worker slot.
- `leased`: a worker has obtained an exclusive lease.
- `running`: worker execution is in progress.
- `verifying`: build finished and post-build checks are running.
- `completed`: verification passed; no deployment has occurred.
- `approval_required`: a deployment-capable action is waiting for explicit human approval.
- `approved`: an authorized human approved the specific action and commit.
- `deploying`: a narrow deployment adapter is executing.
- `deployed`: deployment adapter completed successfully.
- `failed`: execution, verification, or deployment failed.
- `cancelled`: job was cancelled before an irreversible deployment action began.
- `rejected`: an approval request was explicitly rejected.

Every transition must be validated, timestamped, attributed, and written to the audit ledger.

## 4. Job invariants

- Only one build job may hold the active worker lease initially.
- A job lease has an expiry and requires heartbeats.
- An expired lease becomes recoverable by the queue manager.
- A job may not be deployed unless its required verification passed.
- A deployment-capable action may not proceed without an approval tied to the exact job, repository, ref, and commit.
- Cancellation must not interrupt an already-started irreversible deployment without an adapter-specific safety rule.
- Repeated webhook deliveries must be idempotent by delivery identifier.
- Job and artifact identifiers must be opaque and non-sequential where practical.

## 5. Initial public endpoint set

### `GET /health`

Returns service health and dependency status suitable for internal monitoring. It must not expose secrets, tokens, environment variables, or unrestricted infrastructure details.

### `POST /webhooks/gitea`

Receives and validates a Gitea webhook.

Required behaviour:

- Validate the webhook signature.
- Validate event type and repository allowlist.
- Capture delivery ID, repository, ref, commit, sender, and event type.
- Deduplicate repeated deliveries.
- Create or enqueue a job according to repository policy.
- Return a stable acknowledgement without exposing internal errors.

### `POST /jobs`

Creates a job from an authorized human or trusted internal caller.

Minimum input:

- repository identifier
- ref or commit SHA
- job type
- requested action, such as build, verify, or deployment-readiness check
- optional idempotency key

The service must validate repository policy before queue admission.

### `GET /jobs/:id`

Returns the caller-authorized job record, current state, timestamps, commit metadata, verification result, approval state, artifact references, and a summary of audit events.

It must not return secrets or unrestricted worker environment data.

### `POST /jobs/:id/approve`

Records explicit approval for a specific deployment-capable action.

Approval must include:

- authenticated approver identity
- approved job ID
- exact commit SHA
- requested deployment target
- approval timestamp
- optional reason or change reference

The endpoint must reject stale, failed, cancelled, or already-deployed jobs.

### `POST /jobs/:id/cancel`

Requests cancellation of a job. The service applies state-specific rules and records the requester and outcome. It must not provide arbitrary process or shell control to callers.

### `GET /artifacts/:id`

Returns or authorizes access to a job-scoped artifact or log bundle after permission checks. Artifact storage must be abstracted so local VPS storage can later be replaced without changing the API contract.

## 6. Internal components

### API server

Handles authentication, authorization, validation, idempotency, endpoint routing, and audit emission.

### Queue and lock manager

Maintains job state, enforces one active lease, handles lease expiry, and prevents duplicate execution.

### Worker launcher

Starts an isolated Docker worker with:

- read-only source input where possible
- job-scoped working directory
- CPU, memory, process, and timeout limits
- no host Docker socket by default
- no root or hPanel credentials
- controlled network access
- explicit output and exit-state contract

### Artifact and log store

Stores logs and result bundles with job ownership, retention metadata, checksums, and access control.

### Verifier interface

Accepts a completed build result and returns structured checks:

- pass/fail status
- test summary
- security or policy findings
- generated evidence references
- deployment readiness

### Deployment adapter interface

Receives a validated, approved deployment request and returns:

- target
- action identifier
- start and completion timestamps
- success/failure status
- sanitized output
- evidence references

Adapters must be narrow and target-specific; they must not expose arbitrary command execution.

### Audit writer

Writes append-only events for requests, state transitions, approvals, worker execution, verification, artifact creation, deployment attempts, and failures.

## 7. Initial data model

### `jobs`

- `id`
- `status`
- `job_type`
- `repository`
- `ref`
- `commit_sha`
- `source_event_id`
- `requested_by`
- `created_at`
- `updated_at`
- `lease_owner`
- `lease_expires_at`
- `started_at`
- `completed_at`
- `failure_code`
- `failure_summary`
- `verification_status`
- `deployment_target`

### `job_approvals`

- `id`
- `job_id`
- `approver_id`
- `commit_sha`
- `deployment_target`
- `decision`
- `reason`
- `created_at`

### `artifacts`

- `id`
- `job_id`
- `kind`
- `storage_key`
- `content_sha256`
- `size_bytes`
- `retention_until`
- `created_at`

### `audit_events`

- `id`
- `occurred_at`
- `actor_type`
- `actor_id`
- `event_type`
- `subject_type`
- `subject_id`
- `metadata`
- `previous_event_hash`
- `event_hash`

The audit record should be append-only. If tamper evidence is implemented, hash chaining must not be treated as a substitute for access control or backups.

## 8. Authentication and authorization

The first implementation should support two distinct authentication paths:

1. Human administrative authentication for browser/API clients.
2. Service authentication for Gitea webhook handling, workers, and trusted internal callers.

Authorization decisions must be made server-side. Unknown or unregistered routes should require authentication by default. Credentials must be stored outside source control and must not be shared with the FCM API, Gitea administrator account, hPanel account, or VPS root account.

## 9. Repository policy

The initial allowlist should explicitly identify approved repositories and permitted actions. Repository metadata must include the provider, owner, repository name, default branch, and allowed deployment targets.

The initial Gitea integration should support:

- repository allowlisting
- webhook signature verification
- commit/ref capture
- delivery deduplication
- read-only source retrieval for builds

Write operations to repositories should not be enabled in the first version unless separately specified and approved.

## 10. Configuration contract

Configuration should be supplied through environment variables or protected runtime configuration, not committed secrets. Expected categories include:

- service listen address
- database or state-store connection
- Gitea base URL and read-scoped credentials
- webhook secret
- worker limits and timeout defaults
- artifact storage root or provider
- authentication issuer and audience
- approved repository and deployment policy
- log retention settings

The service must fail closed when required security configuration is missing.

## 11. Repository skeleton

```text
bob-control-plane/
├── Dockerfile
├── docker-compose.yml
├── README.md
├── package.json
├── src/
│   ├── server.js
│   ├── config/
│   ├── auth/
│   ├── routes/
│   ├── jobs/
│   ├── queue/
│   ├── workers/
│   ├── artifacts/
│   ├── verification/
│   ├── deployments/
│   ├── audit/
│   └── integrations/gitea/
├── migrations/
├── test/
└── docs/
    └── service-contract.md
```

The skeleton is a target structure, not evidence that these files currently exist on the VPS.

## 12. Build and deployment contract

The first Docker image should be built from the Bob source repository and tagged with an immutable commit tag, with `latest` used only as a convenience alias if required.

The Compose service should:

- run as a non-root user where feasible;
- expose only the intended internal API port;
- use a persistent state volume only for explicitly defined service data;
- use protected environment configuration;
- restart on failure;
- include health checks;
- avoid mounting the host Docker socket unless the worker architecture explicitly requires a controlled alternative;
- keep the control-plane API separate from the FCM API container.

## 13. Definition of ready for implementation

Before building the first image, confirm:

- service-versus-module decision: separate service;
- endpoint contract accepted;
- job state transitions and invariants accepted;
- human and service authentication paths selected;
- initial repository allowlist defined;
- worker isolation limits defined;
- artifact retention and storage location defined;
- deployment targets and approval requirements defined;
- source repository created;
- secrets provisioned separately from source;
- Dockerfile and Compose health check implemented;
- integration tests cover webhook validation, idempotency, queue locking, lease expiry, approval binding, and audit events.

## Current operational truth

The FCM runtime images are present on the VPS. Bob control-plane remains a design and implementation task. No Bob endpoints, authentication behaviour, queue semantics, deployment actions, or control-plane image should be described as deployed until the source is built, started, and verified on the VPS.