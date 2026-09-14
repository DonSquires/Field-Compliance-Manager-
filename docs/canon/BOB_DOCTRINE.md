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
| Planner | `apps/api/src/bobPlan.ts` (23 routes) → conductor cross-checks | VPS `/api/bob/plan` via `callPlan`; `bob-inference` |
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

1. **Governance lock vs de-caging.** The lineage retired universal
   propose→approve as the default posture, yet `isGovernanceLocked` ("no
   operational writes from the chat path") still ships in both lines. Decide
   per write class which LOW-tier writes may `auto_in_context` with a surface
   confirm, and record it as a ruling; until then the lock stands.
2. **Rank gate finding.** A `master` reached full cross-org resolution unchecked
   in the lineage (#324). The Tier-1/2 egress rule must be re-proven here.
3. **Tier-3 HSWA duty-to-warn path.** `safetyFloor` exists but the Tier-3 egress
   path (surface warning, strip identity) must be verified end-to-end.
4. **Builder autonomy ceiling.** This repo's Builder runs bounded sequences with
   human approval gates and stops at `release_ready`; deployment stays a
   separate human act. Keep it so unless a ruling widens it.

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
