# Bob Doctrine — reconciled

> Canon (reconciled). Sources: GitLab lineage `docs/bob/BOB_CORE_ENGINE_NORTH_STAR.md`
> (ratified), `docs/BOB_ARCHITECTURE.md`, `docs/bob/BOB_RUNTIME_CONTRACT_V2.md`,
> `docs/bob/BOB_COCKPIT_NORTH_STAR.md`, `docs/BOB_AGENTIC_CONTRACT.md`,
> `docs/SECURITY_APPROVALS_AUDIT.md` (read 2026-09-14 via `scripts/gitlab-read.mjs`),
> and this repository's `AGENTS.md`, `docs/BOB_CREDENTIAL_BOUNDARIES.md`,
> `docs/BOB_ISSUE_TRIAGE.md`, `docs/BOB_ENTERPRISE_SAAS_UX_TRAINING.md`. Where the
> two lines disagree this document says so and names the owner decision instead
> of smoothing it over. Sits below `FOUNDATION.md`; above every Bob build note.

## 1. What Bob is

- One of the platform's **two core engines** (geofence = where / what applies;
  Bob = think / do). Not a data-entry assistant bolted onto a CRM, and not a
  governed form that proposes one row and waits
  (`PLATFORM_ENGINES_AND_MODULE_PROFILE.md` §2).
- **ONE BOB** (owner-ratified invariant): chat, fleet-wide reasoning, governed
  operational writes, and build/ops work (MRs, self-heal, CI) are the same agent
  with one identity, one memory and one governance loop, varying only by caller
  rank and earned readiness.
- Persona: the ship's computer — natural language on every bridge, coordinating
  the crew within rank. Self-thinking (plans, self-corrects), proactive (acts on
  standing routines and safety triggers), heuristic (meaning, not keywords),
  learning (only approved facts).
- **Truth Protocol:** every output labels known / inferred / unknown with
  confidence and provenance. Bob never fabricates; a missing fact is stated as
  missing. This is the `FOUNDATION.md` mission applied to the agent.

## 2. The two rails (the only legitimate constraints)

1. **Rank.** admiral = `grand_master` (the only cross-org-unrestricted rank) →
   captain = `master` (org tree) → commander = `admin` → `admin_officer` →
   `officer` → guest. Tool availability, disclosure depth and write authority
   scale with the *caller's* rank, never with Bob's.
2. **NZ Privacy Act 2020** — binding even on the admiral. PII is org-owned and
   org-scoped; cross-org reads are audit-logged; redact PII before any external
   or model call (`DATA_CLASSIFICATION.md`, `RETENTION_DOCTRINE.md`).

Plus three load-bearing gates that are not "cage": the geofence verification
gate (`GEOFENCE_PRINCIPLES.md` P2), the protected-path escalation (schema
migrations, auth/identity, destructive bulk operations), and the Truth Protocol.

**Owner ruling:** any Bob constraint that does not implement Rail 1, Rail 2 or
one of those three gates is *cage* and needs recorded owner sign-off. Apply the
One-Bob test to every change.

## 3. "Bob thinks fleet-wide, speaks within rank"

Tenant isolation is a property of **egress**, not a wall around Bob's reasoning.
Bob may read across the fleet to find cross-org H&S and risk patterns (a headline
feature, never a risk to suppress); the Conductor redacts what leaves toward the
caller. Four-tier egress model:

| Tier | Content | Below admiral |
|---|---|---|
| 0 | entity name, managing org, physical address | always surfaceable |
| 1 | operational relationships (service agreements) | forbidden out-of-scope |
| 2 | operational data (breaches, contracts) | forbidden |
| 3 | safety signals (HSWA duty to warn) | surface the warning, strip identity |

RLS remains the hard backstop underneath. In this repo the mechanism is
`onspace-ai-chat`'s `resolveUserCapabilities` → `computeEgressForbiddenSet` →
`applyEgressSweep` / `redactOutgoing`; `safetyFloor` is the Tier-3 hook.

## 4. Autonomy: impact tier × readiness × rank × protected floor

- **Impact tiers** (reconciled 2026-07-25): **LOW** — Bob prepares, the bell
  notifies, a human confirms in context (earned readiness may make it
  `auto_in_context`, still a visible confirm). **MEDIUM** — surface confirm, no
  SLA auto-proceed. **HIGH / irreversible** — bell advises, escalate by rank,
  never auto-execute. The bell is notification plus risk advice, not an
  approval gate.
- **Readiness ladder** 0 Passive → 1 Triage → 2 Patch planner → 3 Guided
  implementer → 4 Active copilot; stored as data; widens only the LOW lane.
- **Sensitive floor (read-only to Bob):** auth, identity, governance and audit
  tables. Bob never writes them.
- **Protected paths are HIGH:** migrations/DDL, auth/RLS, dependency and
  environment changes, protected-branch merge, deployment, destructive bulk
  ops. Bob may *draft* them (an MR, a proposal artifact) — humans review, merge
  and deploy. Autonomy v1 is locked to "a human turns the key"; no unattended
  poll-and-act.
- **Legal, identity-critical, enforcement and commercial truth is human-decided.**
  Bob explains verdicts, finds missing evidence, drafts wording, prepares
  proposals; a person signs (the fire-control key in `PRODUCT_DESIGN.md` §7.2).

## 5. Runtime contract (how this repo implements it)

| Role | GitLab lineage | This repo |
|---|---|---|
| Conductor — turn gate, tool dispatch, egress, task/memory state | `onspace-ai-chat` + `resolveUserCapabilities`/`gateTool`/`redactOutgoing` | `supabase/functions/onspace-ai-chat/index.ts` (`isToolEffectPermitted`, `applyEgressSweep`, `persist`, `emitEvent`) |
| Caddie — tool catalogue from Atlas-wired capability; describes, never selects | `caddie.ts` `TOOL_REGISTRY` + caddie cards | `supabase/functions/onspace-ai-chat/caddie.ts` (`generateToolCatalogue`) |
| Oracle — truth-state of turn, caller, candidate effect, proof grade, safety | welfare seam | `conductor-oracle.ts`, `conductor-welfare-seam.ts` |
| Atlas — capability map, terrain edges, gap report, blast radius | `bob-query-atlas` (admiral) | `bob-query-atlas`, `bob_capability_map`, `bob_app_map_edges`, `scripts/atlas-refresh.js` |
| Planner | `apps/api/src/bobPlan.ts` (23 routes) → conductor cross-checks | VPS `/api/bob/plan` via `callPlan` → `services/fcm-api/src/bob/plan.js` (prompt `planPrompt.js`, model routing `modelGateway.js`); `bob-inference` fallback |
| Verifier (chat lane) | — | `services/fcm-api/src/bob/verify.js`: deterministic checks + independent critic (different model), recommend-only; author repairs once |
| Working subagents | Duo flows (GitLab) | planner `delegate` → conductor `runSubagents` (read-only tools via `dispatchTool`) + VPS `/api/bob/subagent` |
| Memory | request → `bob_messages` → `bob_context_memory` → `bob_knowledge_cards` → `bob_learning_memory`; `bob_self_memory` is Bob's own diary; growth is human-judged | same tables live; `bob_self_memory` present; knowledge cards never written from chat |
| Build/ops | `bob-review-merge-request`, `bob-read-issues`, Gitea/GitLab MR flow | Builder control plane (`bob-control-plane-server.js`, `worker-executor.js`, `builder_*` tables, `builder_approvals`), Gitea PRs, no merge/deploy authority |

Bob's evidence order is fixed: human observation → schema/Atlas inspection → live
read verification → bounded web research → smallest discriminating next check
(`AGENTS.md`). Atlas `flow_reach` and `fk_reach` are never conflated; `wired` is
not `exercised` (live `bob_capability_map` has **0** rows marked exercised — the
column is unpopulated, so treat every "exercised" claim as unproven).

## 6. Cockpit direction

Bob is engine *and* autopilot with three modes — MANUAL (excellent without Bob),
ASSISTED, AUTOPILOT. Global primitives: a visible "who is flying" indicator,
takeback is sacred, results land in their natural habitat (the page, not a chat
drawer), one grammar everywhere. `classifyAutonomy` outcomes map to who flies:
`auto_in_context` = Bob; `notify` / `escalate` = ask first; `owner_only` /
`deny` = manual. `FieldSafetyBar` is the proven idiom for wiring Bob into the
officer shell.

## 7. Open owner decisions (do not resolve by drift)

1. **Governance lock vs de-caging — RULED for the agentic lane 2026-09-14 (see §9).**
   The chat lane stays egress-governed by rank; the agentic/Builder lane works
   as a coding agent works, with subagents supporting and verifying. Still open:
   whether any LOW-tier *operational* write may `auto_in_context` from the chat
   path (`isGovernanceLocked` stands there until ruled).
2. **Rank gate finding.** A `master` reached full cross-org resolution unchecked
   in the lineage (#324). The Tier-1/2 egress rule must be re-proven here.
3. **Tier-3 HSWA duty-to-warn path.** `safetyFloor` exists but the Tier-3 egress
   path (surface warning, strip identity) must be verified end-to-end.
4. **Builder autonomy ceiling.** Human approval stays at the protected paths
   (§9). The eight-action ceiling in the bounded runner is an operational safety
   limit, not a governance gate; widening it needs evidence of stable
   subagent verification, not a ruling.

## 8. Rules for every Bob change

- Teach, don't cheat: no task-specific decision trees or keyword routing for
  Bob; Atlas maps terrain, Caddie describes tools, Oracle describes truth,
  Conductor gates egress/effect and dispatches the tool Bob chose.
- New constraint? Name the rail or gate it implements, or get a ruling.
- New write path? Idempotent (`client_request_id`), audited (`audit_log`),
  tenant-scoped, through a governed RPC/Edge Function, with the impact tier
  declared.
- Never expose service-role credentials, tokens or another person's session to
  Bob, a worker, a prompt, a log or a browser (`docs/BOB_CREDENTIAL_BOUNDARIES.md`).

## 9. Rulings recorded in this repository

### 2026-09-14 — Two lanes, one Bob (Don Squires)

> "Bob chat should be governed on what is shared with the user except owner;
> agentic Bob should be able to work as you do, with subagents supporting and
> verifying the work."

**Chat lane.** What Bob *shares* with the user is governed by the caller's rank
(the four-tier egress model, §3). The owner (`grand_master` / admiral) is
unrestricted. This is a disclosure rule, not a reasoning cage: Bob still thinks
fleet-wide. Operational writes from the chat path are unchanged by this ruling
(`isGovernanceLocked` stands until a separate ruling names the write classes).

**Agentic lane.** Bob works the way a coding agent works: plan → implement →
verify → iterate, delegating research, implementation and verification to
subagents and continuing without a human confirm at each step. In this
repository the subagents are the Builder specialists
(`supabase/functions/_shared/builder-*.js`: product analyst, UX designer,
frontend and backend engineers, independent code review, security review,
release engineer) plus the isolated worker profiles (`worker-executor.js`:
`frontend-verify`, `backend-verify`, `security-review`, `test`, `build`, `lint`).
Independent review and security review are the *verifying* subagents and keep
their rule: a different model identity from the author, recommend-only, bound
to the exact patch and commit.

**What does not move.** The protected paths remain human-approved and are the
only places a human is required: merge to a protected branch, deployment,
applying a migration or any DDL, auth/RLS changes, dependency and environment
changes, destructive bulk operations. Bob drafts these (branch, MR, proposal
artifact, `release_ready`); a person applies them. The sensitive floor (auth,
identity, governance, audit tables read-only to Bob) and the two rails are
untouched.

**Build implication (`docs/REBUILD_PLAN.md` §9).** Let the bounded Builder
runner continue through implement → verify → repair loops on subagent evidence
rather than stopping for a human after each specialist action; stop only at a
protected path, a blocked state, a failed verification the subagents cannot
repair, or the operational action ceiling.

### 2026-09-26 — Bob's brain restored, verified, delegating, in-house (Don Squires)

> "Bob is not just a chat bot, he is an agentic heuristic agent that works
> through the entire app and is also meant to be able to do self healing work …
> subagents to verify Bob's work before it is sent to the user … Bob should be
> able to ask sub agents to do work for him as appropriate … Bob should be
> running in the VPS and laptop GPU … self healing must be able to work in the
> GH repo."

**Finding.** The canonical planner (`apps/api/src/bobPlan.ts` in the lineage)
was lost when the VPS API was rebuilt on 2026-09-06; `/api/bob/plan` had become
a one-sentence stub that dropped persona, the in-flight plan, conversation
facts, knowledge, and task state. That is why Bob interrogated instead of
drafting and re-asked questions the owner had already answered ("yes to all").

**Ruling and mechanism.**
- **Planner** — restored and extended in `services/fcm-api/src/bob/planPrompt.js`
  (Truth Protocol, drafting discipline, one-question rule, blanket-answer
  resume, delegation, self-heal evidence-first). One canonical prompt; the
  conductor stays the gate.
- **Verifying subagent (chat lane)** — `services/fcm-api/src/bob/verify.js`:
  deterministic checks plus an independent critic on a *different model
  identity* from the author, recommend-only; the author repairs once from
  reviewer notes (self-heal), then a mechanical scrub as the last resort. The
  verdict is persisted on the turn (`bob_messages.metadata.verification`,
  `bob_event_log` `plan_verified`) and shown to the user as "Checked".
- **Working subagents** — planner action `delegate`; the conductor runs up to
  three read-only subagents in parallel under the caller's own envelope through
  `dispatchTool` (rank gating, egress and audit unchanged), then Bob plans again
  over their findings. Writes never reach a subagent. Events `subagent_started`,
  `subagent_step`, `subagent_completed`, `delegation_completed`.
- **Synthesis pass** — a tool result that is reasoning context (`[INTERNAL…]`,
  web research, Atlas, SQL rows) is never returned raw; the planner answers over
  it (`synthesis_completed`).
- **In-house brain** — `services/fcm-api/src/bob/modelGateway.js` routes each
  role through `gpu_workstation → vps_ollama → openai` chains
  (`BOB_ROUTE_*`); the owner's laptop GPU joins over a forwarding-only reverse
  SSH link (`scripts/bob-gpu-link/`). The author role stays on the strongest
  model unless routed in-house on purpose; the verifier prefers the GPU, which
  also keeps it a different identity from the author. Health: `/api/bob/health`.
- **Self-heal in the GitHub repository** — Bob tool `create_builder_job`
  (admiral only, two-turn confirm) opens a Builder job pinned to GitHub `main`;
  the Builder lane publishes to GitHub with per-invocation credentials and opens
  a **draft** pull request (`builder-branch-workspace.js`,
  `bob-control-plane-server.js` `BUILDER_GIT_HOST=github`). Merge, deploy and
  migrations remain human (§9 protected paths unchanged).

**What does not move.** Rank and Privacy Act rails, `isGovernanceLocked` on the
chat path, the sensitive floor, and the protected paths are untouched.

### 2026-09-26 — Autopilot: Bob finishes what he is asked to build (Don Squires)

> "I'm not a coding person and don't know if Bob is building or correcting the
> right things; all I know is what I want and how it should work and look. So
> Bob is going to need to be as reliable as you and just push fixes as you do
> and let me know what has happened once it's done, as you do."

**Finding.** The first end-to-end self-heal run (jobs `5ba292f4`, `3a4a2d06`,
`42b542a5`) proved the Builder lane could build, verify, review and publish a
Bob-authored change — but only with an operator driving every gate and
publication step by hand, and it surfaced eight latent defects that had made
the lane unusable since early September (audit event types, repository
inventory cap, worker image manifest, patch newline handling, the security
claim's patch anchor, the reviewer's missing model and output contract, the
release engineer's output contract, the commit step's frontend fence). Each is
fixed, tested and recorded in the commit history of this date.

**Ruling and mechanism.** The 2026-09-14 ruling already lets the agentic lane
continue without a human confirm at each step. The owner's chat instruction to
make a change is the key turn. From it, Bob autopilot
(`builder-autopilot.js`, control plane) drives the job to a reviewed pull
request unattended:
- **Gates** — `specification_review` and `release_approval` are cleared on the
  requester's behalf by `builder_autopilot_decide_approval`, which mirrors the
  human RPC's invariants and records the requester as approver and Bob as
  actor (`source: bob_autopilot`). Rejection stays human-only.
- **Runner** — the bounded runner keeps moving (ceilings: eight actions per
  run, `MAX_STEP_ATTEMPTS` per step); a retryable failure is retried next tick,
  a ceiling or terminal state becomes a **blocked** report.
- **Publication** — at `release_ready` the worker-validated diff is committed
  on the job branch, pushed, and opened as a pull request whose body carries
  what changed, how it was verified (author's tests, isolated worker, security
  scan, independent AI review) and provenance.
- **Report** — a plain-language outcome is stored on the job
  (`autopilot_report`); the conductor gives it to the planner as
  `completed_work` on the requester's next turn and Bob leads with it (what
  changed in behaviour terms, how it was checked, the review link, what the
  person must do). Marked reported once relayed.

**What does not move.** Merge, deployment, DDL, auth/RLS, dependency and
environment changes remain human; the pull request is a draft for a person.
Bob never approves on behalf of someone who could not approve themselves
(`can_approve_action` is checked for the requester), never rejects, and never
clears a gate on a job nobody asked for (`autopilot_requested_by` is required).

### 2026-09-26 — Human approval is required for evidential work (Don Squires)

> "Human approval is required for evidential work."

**Ruling.** The autopilot ruling above lets Bob clear his own gates on the
requester's standing instruction. This ruling narrows it: where the work is
**evidential**, a person decides every gate. Evidential work is code that
captures, classifies, alters, presents, or delivers records a person may rely
on as evidence of harm or compliance — the anchor of [FOUNDATION.md](../../FOUNDATION.md):
evidence capture and photo/video/CCTV inference, incidents and breaches,
notices and infringements, patrol and dispatch records, observations, vehicle
and plate lookups, report packs and their delivery, audit trails, signatures,
and the field-staff portal and desktop import tools in their entirety. It
also covers promoting values extracted from sample or imported material into
business records (already a governed, human-approved path in `AGENTS.md`).

**Mechanism.** `builder-path-policy.js` (`isEvidentialPath`,
`evidentialMentions`) classifies repository paths deterministically:
capture/inference surfaces by root, everything else by the evidential terms
in the path, with Bob's own machinery, docs and tooling classified by the code
they touch rather than their wording. At each gate the autopilot classifies
the brief's named paths and — at the release gate — the files the verified
patch actually changed. If any is evidential the gate is **not** cleared: the
job is parked as `autopilot_state = 'awaiting_human'` with a plain-language
report ("Needs your approval … touches evidential work"), an
`approval_requested` audit event, and Bob relays it in chat. A person decides
through `builder_decide_approval` (Builder control room); the autopilot
resumes only after that decision, or reports the job as stopped if it was
declined. Non-evidential work keeps the autopilot flow; migration
`20260927050000_builder_autopilot_awaiting_human.sql`.

**Consequences for merging.** Bob still merges nothing. A non-evidential Bob
pull request that has passed the isolated worker, the security scan and the
independent review may be merged by the owner or, on the owner's standing
instruction to the coding agent ("just push fixes as you do"), by the coding
agent after its own review — as was done on this date for pull requests #2,
#3 and #4 (chat-verifier affirmatives; test-driver re-login). An evidential
pull request is merged only by a person. Whether Bob may one day merge
non-evidential work himself is an open owner decision (§7), not something to
resolve by drift.

**Tuning.** The term and root lists are a floor, not a ceiling: adding a path
is a one-line change; removing one is an owner decision recorded here.

### 2026-09-26 — Bob's compute and terminal on the owner's laptop (Don Squires)

> "The laptop is connected using Tailscale … we should give Bob Windows
> PowerShell so he can access files on my computer if I want him to, and also
> have a terminal to work with."

**Ruling.** The owner's laptop (`fcm-gpu-laptop`) joins Bob's in-house compute
over the private Tailscale network, and Bob may use a PowerShell terminal on it
— **only while the owner allows it and only for commands the owner has seen and
confirmed**. This is the owner's own machine: the terminal is a convenience the
owner grants and withdraws, not a Bob entitlement.

**Mechanism.** Windows' built-in OpenSSH Server, PowerShell as its shell,
reachable from the VPS's Tailscale address only, started and stopped by the
owner (`scripts/bob-gpu-link/laptop-tailscale.ps1 -Allow / -Deny`). Bob's
private key lives only in the control plane's data volume. In chat
(`laptop_shell`, admiral only) Bob shows the exact command and purpose and runs
it only on the owner's affirmative; the control plane (`bob-laptop-shell.js`)
refuses destructive, privilege-changing, credential, firewall, persistence and
link-cutting commands regardless of confirmation, caps and redacts output, times
out, and records the command's head and hash — never its output, which may be
the owner's private files. The Builder lane does not get this tool: Bob builds
software in isolated worktrees, not on the owner's machine.

### 2026-09-27 — Bob merges his own reviewed work; the owner keeps the off switch (Don Squires)

**Ruling.** The owner cannot review code and has asked to be hands-off: Bob does
the coding and does not ask a human to fix anything. A Builder change therefore
merges itself when — and only when — it was requested in chat, the isolated
worker re-applied and verified the patch, the security scan passed, the
independent review (strongest model first, a different model from the author)
passed with no critical or high finding, and no evidential path is touched.
Anything else stays a draft pull request for a person, and evidential work still
waits for a human (the 2026-09-26 ruling stands). The mechanism is env-gated on
the control plane (`BOB_AUTOPILOT_AUTOMERGE=true`, `automergeEligible` in
`builder-autopilot.js`, the bridge merges on the marker in the pull-request
body); removing that line restores per-change human merging. The release lane
(`scripts/bob-release-lane.sh`, live mode) puts merged `main` into service with
health checks and rollback, and Bob reports in chat what merged and what went
live. §4's "a human turns the key" is amended to this: the key is the owner's
off switch, not a per-change approval.
