# Bob App Builder - Build Plan

## Product Vision & Core Mission

Field Compliance Manager is an enterprise operations and compliance platform designed to replace multiple disparate single-purpose applications used by security companies, field compliance providers, and local councils (e.g. separate apps for noise control, parking, freedom camping, patrol routes, static guarding, biosecurity, smoke complaints, PTT dispatch, and welfare monitoring) into a single, unified, multi-tenant platform.

### Core Build Directives

1. **Multi-Module Consolidation & Independence**: Any organization can subscribe to any single module or any combination of modules. All modules share the global canonical identity spine (`person`, `place`, `vehicle`, `organisation`, `scv`).
2. **Court-Ready 100% Honest Evidence**: 100% truthful, tamper-evident reporting. Immutable provenance (GPS, timestamps, geofence, officer ID, photo hashes). Zero silent fabrication.
3. **Bob Heuristic Field Copilot**: Integrated into all portals via a clean human interface for contextual assistance, hazard alerts, shift debriefs, and evidence drafting.
4. **Bob Multimedia Owner/Grand-Master Studio**: An advanced studio allowing owners and grand-masters to work with Bob inside the app to build, extend, and maintain the system. Powered by the server-side Bob Control Plane Server (`bob-control-plane-server.js`) to bypass Supabase Edge limits while retaining strict non-root isolated workers and human approval gates.

## Goal

Extend the existing Bob control-room platform on VPS 1601189 with a controlled AI sub-agent for building applications through product analysis, UX/UI design, coding, testing, security review, and release preparation.

The first release supports one isolated build job at a time and stops at a human approval gate before production deployment.

## Existing platform

- Gitea repository platform and Gitea Runner
- Existing Bob control-room web container
- VPS 1601189 for supporting compute
- Supabase for authentication, database, storage, and Edge Functions
- Vercel for the customer-facing frontend
- OpenAI for complex coding and reasoning
- Ollama for low-risk local summarization and classification

## Agent roles

### Bob Orchestrator

Owns job state, delegates specialist work, records decisions, collects artifacts, and controls approvals. It must not execute unrestricted production commands.

### Product Analyst

Produces the product brief, user roles, user journeys, functional and non-functional requirements, data model proposal, acceptance criteria, and unresolved questions.

### UX/UI Designer

Produces the information architecture, route map, component inventory, responsive behaviour, design tokens, accessibility requirements, and loading, empty, error, and success states.

### Frontend Engineer

Implements approved interface changes, follows repository conventions, creates reusable components, adds validation and error handling, and updates tests.

### Backend Engineer

Implements approved database, API, authentication, authorization, storage, and integration changes. Produces migrations and rollback notes and keeps secrets server-side.

### QA and Security Reviewer

Runs tests, checks permissions and input validation, reviews dependencies and generated changes, detects secrets and unsafe commands, and produces a pass/fail report with evidence.

### Release Engineer

Produces build metadata, deployment checklist, migration order, environment-variable checklist, rollback plan, and release notes.

## Job lifecycle

`intake` → `analysis_pending` → `specification_ready` → `design_pending` → `implementation_pending` → `building` → `testing` → `security_review` → `approval_pending` → `release_ready` → `deployed`

Failure and cancellation states must be supported. Every transition creates an immutable audit event with actor, timestamp, job ID, repository, commit SHA, action, and result.

## Isolated worker contract

Each worker receives only the repository and commit reference, task specification, approved model configuration, explicitly approved environment variables, and temporary artifact paths.

Workers must not receive hPanel credentials, root credentials, unrelated repositories, or production secrets by default. Each run requires a clean workspace, non-root execution, resource limits, a timeout, command allowlisting, secret redaction, and automatic cleanup.

## Required artifacts

- Product specification
- UX/UI plan
- Changed-file manifest
- Patch or commit reference
- Build logs
- Test results
- Security review
- Screenshots where applicable
- Release checklist
- Rollback notes
- Final summary

## Approval gates

Human approval is mandatory before merging protected branches, production deployment, schema changes, authentication or authorization changes, dependency changes, secret or environment-variable changes, broad infrastructure changes, or destructive operations.

## Phase-one vertical slice

1. Create a Builder job from the Bob control room.
2. Attach a repository and task description.
3. Run Product Analyst mode.
4. Run UX/UI Designer mode.
5. Run Frontend Engineer mode in an isolated worker.
6. Run tests and collect logs.
7. Run the security review.
8. Display artifacts and approval controls in the control room.
9. Stop before deployment and record the release-ready result.

## Supabase entities

- `builder_projects`
- `builder_jobs`
- `builder_job_steps`
- `builder_artifacts`
- `builder_approvals`
- `builder_audit_events`
- `builder_protected_variables`
- `builder_worker_runs`
- `builder_model_runs`

Every entity must be organization-scoped and protected by server-side authorization.

## Model routing

OpenAI handles implementation, complex debugging, architecture, security reasoning, and final synthesis. Ollama handles repository summaries, file classification, simple documentation, and low-risk preprocessing. Every model run records its model, prompt version, input and output artifact references, status, and available usage metadata.

## Implementation order

1. Inspect the current Bob control-room source and API boundaries.
2. Define the job, worker, artifact, approval, and audit schemas in Supabase.
3. Implement the orchestrator state machine.
4. Implement the isolated worker adapter.
5. Add OpenAI and Ollama adapters.
6. Add Product Analyst, UX/UI Designer, Frontend Engineer, and QA/Security modes.
7. Persist artifacts and audit events.
8. Add guarded approval transitions.
9. Run a small test project through the complete workflow.
10. Keep production deployment disabled until the workflow is proven.

## Definition of done

A user can submit a small app change through Bob, receive an analysis and UI plan, generate code in a disposable worker, inspect tests and security results, review artifacts, and approve or reject the result. No production deployment occurs in phase one.