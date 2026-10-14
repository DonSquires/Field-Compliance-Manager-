# Bob App Builder - Build Plan

## Primary governing principle

Before any implementation work begins, every agent, reviewer, planner, and contributor must understand and operate under the following doctrine.

### Product mission

The app exists to encourage and ensure accountability: record field work honestly, preserve it faithfully, and prove it when it matters. Compliance is the visible result of good accountability, not the primary purpose on its own.

### Product definition

Field Compliance Manager is an enterprise operations and compliance platform designed to replace multiple disparate single-purpose applications used by security companies, field compliance providers, and local councils (e.g. separate apps for noise control, parking, freedom camping, patrol routes, static guarding, biosecurity, smoke complaints, PTT dispatch, and welfare monitoring) into a single, unified, multi-tenant platform.

The system allows any organisation to subscribe to and operate any single module independently or any combination of modules together. It is built around a global canonical identity spine (person, place, vehicle, organisation, certification) and answers: what happened, where, when, by whom, under what authority, and what court-ready evidence supports that account.

### Court-Ready Reporting & 100% Honest Evidence Doctrine

The platform must generate court-ready, legally defensible, tamper-evident compliance and incident reports.
- **100% Truthful Record Keeping:** Every record, observation, notice, chalk, assessment, and report must preserve immutable provenance (timestamp, GPS coords, verified geofence boundary, officer identity, vehicle plate, photo hash, and statutory authority).
- **Zero Silent Fabrication:** If spatial data, rate rules, or witness facts are missing, the system explicitly marks them as unknown. No record is ever guessed, back-filled, or fabricated.
- **Tamper-Evident Audit Chains:** Changes to operational records generate append-only audit entries and receipts, ensuring reports stand up in judicial, council, and administrative hearings.

### Bob’s Dual Architectural Role: Heuristic Field Copilot & In-House App Builder

Bob is the integrated AI intelligence layer across the entire platform, operating with two complementary roles:

#### 1. Heuristic & Agentic Operational Copilot (Simple Field & Admin Interface)
- Integrated into every portal (`OfficerShell`, `AdminShell`, `ModuleShell`) through a clean, intuitive human interface (side panel, voice interface, notification center, and contextual action triggers).
- Operates heuristically across modules to assist officers and dispatchers with live spatial resolution, hazard alerts, shift debriefs, and evidence drafting.
- Guided by the **Conductor-Caddie-Planner-Oracle** architecture (`onspace-ai-chat`), where policy enforcement and safety precedence are server-enforced at the post-selection seam.

#### 2. Advanced Multi-Media & Multi-Ability Studio (Owner / Grand-Master Control Plane)
- A dedicated, high-capability Studio interface giving owners and grand-masters the ability to work directly with Bob inside the application to continuously build, extend, test, and refine the app.
- Operates with capabilities matching IDE/Codespace AI agents (product analysis, UX design, code extraction, multi-file editing, test execution, security review).
- Bypasses standard Supabase Edge Function payload and timeout restrictions via the server-side **Bob Control Plane Server** (`bob-control-plane-server.js` running on dedicated compute / VPS runner infrastructure), while strictly enforcing role governance, isolated disposable worker containers, immutable audit trails, and human approval gates before production publication.

## NZ security good-practice build track

The product must stand up to the operational expectations in the [NZSA Security Services Good Practice Guidelines](https://security.org.nz/wp-content/uploads/2023/04/NZSA-NZ-Security-Services-Good-Practice-Guidelines_April-2023.pdf), including its WorkSafe-endorsed health-and-safety guidance. This is a product-design and evidence requirement, not a claim that the software itself certifies legal compliance.

The guideline requires a planned, factual, auditable management system covering risk, incident and emergency management, worker engagement, consultation and coordination, training, deployment, site safety, supervision, working alone, customer communication, record keeping, technology use, accountability, and continual improvement.

Bob's document workspace must therefore support governed, source-linked drafts for:

- site safety plans and site hazard registers
- security risk assessments and control reviews
- emergency response plans and drill records
- incident, near-miss, investigation, root-cause, and corrective-action reports
- worker consultation and health-and-safety communication records
- training, competency, induction, deployment, and pre-start checklists
- supervision, welfare, working-alone, and remote-work plans
- customer service reviews, patrol/logbook reports, and handover briefs
- audit, management-review, and continual-improvement reports
- contract-transition and Part 6A employment documents

Every generated document must preserve the organisation, branch, agreement, site, zone, responsible person, review date, source evidence, assumptions, unknowns, approval state, version, retention state, and audit receipt. Photos, logos, diagrams, and other media require provenance, tenant scope, approved usage, and an explicit relationship to the document or evidence record.

Bob may classify, retrieve, compare, draft, and recommend. Bob must not silently publish an operational instruction, declare a risk controlled, close an incident, certify competency, or create a legal, employment, financial, enforcement, or safety conclusion. Consequential outputs stop at human review and use a governed command before promotion.

### Good-practice acceptance gates

Before release of a safety or compliance document workflow, the build must demonstrate:

1. A role- and organisation-scoped authoring path with loading, empty, error, permission, stale, draft, approved, rejected, and superseded states.
2. Source-linked fields and citations that identify the document/version and page, paragraph, cell, evidence item, or event where available.
3. Human review with named actor, rationale, expected-state checks, approval timestamp, and immutable audit evidence.
4. Retention, legal-hold, restricted-access, download-audit, and sealed-evidence behaviour where the document or media requires it.
5. Responsive and accessible desktop/mobile workflows tested with real browser interaction.
6. A truthful receipt showing what was created, what remained unknown, what was not applied, and the next responsible owner.

The implementation must also account for the NZSA Part 6A vulnerable-worker guidance when generating contract-transition, workforce handover, or employment-related documents. It must never present a generated employment or legal document as final advice.

### Customer-facing logic

The product is not just a task log. It exists to make defensible service delivery possible. If a council asks whether a complaint was attended, or a client disputes patrol coverage, or an enforcement action is challenged, the value is in the coherent record rather than memory.

The system must protect people first, then property, and must anchor to the harmed party and place of harm rather than whichever organisation happened to be administratively convenient.

### Required agent rule

All agents, including Bob, must read and apply this doctrine before making any code, schema, workflow, or operational change. If a proposal conflicts with the doctrine, it is not accepted as product direction.

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
- `builder_worker_runs`
- `builder_model_runs`

Every entity must be organization-scoped and protected by server-side authorization.
Builder workers use fixed, isolated execution profiles and do not accept
tenant-configured environment-variable injection. The unused
`builder_protected_variables` prototype was retired on 2026-10-14.

## Model routing

OpenAI handles implementation, complex debugging, architecture, security reasoning, and final synthesis. Ollama handles repository summaries, file classification, simple documentation, and low-risk preprocessing. Every model run records its model, prompt version, input and output artifact references, status, and available usage metadata.

## In-house AI boundary

The strategic advantage should be an in-house Bob system, not an attempt to train a foundation model from scratch. We own the control plane, Atlas graph, policy engine, approval gates, audit trail, memory, retrieval index, tool contracts, evaluation suite, and model-routing decisions. Those are the parts that understand this organisation's work and must remain accountable, inspectable, and portable.

Model providers are replaceable inference components. Local Ollama models should handle low-risk classification, summarisation, redaction assistance, and repository preprocessing where privacy or cost makes local execution valuable. Hosted models may handle difficult implementation, debugging, architecture, and synthesis, but only with approved inputs, explicit provenance, and no unapproved production credentials.

Do not train or host a bespoke foundation model until measured workload, evaluation data, latency, privacy, and operating-cost evidence justify it. Fine-tuning or retrieval improvements should come only after the governed workflow is reliable. Bob's identity is the accountable system around the model, not the model vendor or the model weights.

## Implementation order

1. Inspect the current Bob control-room source and API boundaries.
2. Define durable task and task-step state so Bob can resume multi-step work from verified progress rather than conversation memory. See [the task continuity contract](docs/bob/task-continuity.md).
3. Define the job, worker, artifact, approval, and audit schemas in Supabase.
4. Implement the orchestrator state machine.
5. Implement the isolated worker adapter.
6. Add OpenAI and Ollama adapters.
7. Add Product Analyst, UX/UI Designer, Frontend Engineer, and QA/Security modes.
8. Persist artifacts, task evidence, and audit events.
9. Add guarded approval transitions.
10. Build the NZSA-aligned operational safety and document-authoring slice with source-linked templates, branding/media provenance, review gates, retention, and audit receipts.
11. Run a small test project through the complete workflow.
12. Keep production deployment disabled until the workflow is proven.

## Definition of done

A user can submit a small app change through Bob, receive an analysis and UI plan, generate code in a disposable worker, inspect tests and security results, review artifacts, and approve or reject the result. The platform can also produce a source-linked, organisation-scoped, reviewable safety/compliance document with approved branding and media provenance, without silently promoting it into an authoritative record. No production deployment occurs in phase one.