# Field Compliance Manager: Whole-System Model

Verified with Bob, live Atlas, `supabase/schema.sql`, application routes, and
the current Bob runtime on 2026-09-02. This document separates source presence,
Atlas wiring, and production proof. None of those states implies another.

## Purpose

Field Compliance Manager is a multi-organization operating system for contracted
field services. It joins the full accountability chain:

`organization -> agreement -> place -> workforce -> assignment -> field event -> evidence -> review -> outcome -> report`

The product is not primarily a set of specialty forms. Its purpose is to preserve
a tenant-scoped, auditable and defensible record of who acted, where, when, under
which authority, using what evidence, and with which human-approved outcome.

The main human surfaces are:

- Admin operations: client and place setup, agreements, HR, rostering, dispatch,
  live operations, review, reporting, finance, and approvals.
- Field operations: assigned shifts, dispatch, patrols, safety, evidence capture,
  specialty assessments, debriefs, and timesheets.
- Client portal: authorized visibility into contracted locations, activity, and
  outcomes.
- Scan operations: narrowly entitled vehicle and place observations.
- Platform operations: module catalogue, subscriptions, Builder, and Bob.

Role routing is owned by `apps/web/src/routing/RoleRouter.tsx`. Database authority
still comes from caller identity, organization scope, agreements, RLS, and governed
RPC or Edge Function boundaries; a visible route is not authorization.

## Shared Spines

Every specialty module depends on the same platform spines:

1. **Tenant and identity**: `organizations`, `user_profiles`, organization trees,
   provider/client grants, and role-aware entitlement functions.
2. **Commercial authority**: `service_agreements`, agreement modules, agreement
   locations, obligations, quotes, rates, and visibility controls.
3. **Place**: `client_sites`, `location_zones`, emerging `locations`, verified
   geometry, and immutable boundary history.
4. **Workforce**: people, staff records, credentials, leave, teams, roster slots,
   assignments, and shifts.
5. **Operations**: shift stops, dispatch jobs, patrol routes, checkpoints, visits,
   welfare state, debriefs, and follow-up ownership.
6. **Evidence and decisions**: observations, private media, assessments, incidents,
   breach signals, notices, cases, formal human decisions, retention, and reports.
7. **Governance**: caller-derived authority, server-side validation, idempotency,
   audit events, review queues, and approval/execution separation.

Parking, noise, biosecurity, smoke, freedom camping, patrol, static guard, access
control, EMS, and future specialties are overlays on these spines. A module must
not create a parallel organization, person, vehicle, place, authority, assignment,
or evidence identity when the shared entity already exists.

## Bob's Architecture

The spelling is **Oracle**, not "Orical".

### Atlas

Atlas is the build-terrain map. `bob_capability_map` records whether an entity is
present, wired, and exercised. `bob_app_map_edges` records live relationships.
`flow_reach` is evidence of reads, writes, calls, or invokes; `fk_reach` is only
structural adjacency. Atlas informs the runtime and rebuild work, but schema and
source remain required cross-checks because generated edges can lag or under-report.

### Caddie

`supabase/functions/onspace-ai-chat/caddie.ts` generates Bob's full Atlas-backed
capability menu and assigns each known tool an effect class. Caddie does not choose
a tool, dispatch it, or hide Bob's internal capability awareness by caller rank.
Unknown effects fail closed.

### Conductor

`supabase/functions/onspace-ai-chat/index.ts` is the live `onspace-ai-chat` entry
point. It plans the next step, selects and dispatches tools, preserves durable turn
and task state, and enforces caller capability plus effect-class policy after
selection and before effect. Consequential actions remain bounded by database,
Edge Function, worker, proposal, approval, and execution controls; model judgment
is not an authorization boundary.

### Oracle

Oracle is currently a truth-state role implemented in the Conductor welfare seam,
not a standalone deployed service or general-purpose database oracle. It describes
welfare truth such as overdue, man-down, SOS, escalation level, and active concern.
It does not select tools, dispatch effects, grant permission, or enforce policy.
The Conductor consumes this truth and makes the enforcement decision.

The honest live gap is that `conductor-welfare-seam.ts` still documents incomplete
server-side welfare-state loading, named authority routing, escalation timing, and
additional safety-signal effects. The seam and first `alert_raise` path are present;
that is not proof of a complete, production-exercised Oracle welfare loop.

### One-Line Model

- Atlas maps what exists and how it is connected.
- Oracle says what is true for the decision.
- Caddie says what capabilities Bob can consider.
- Conductor decides, dispatches, and enforces before effect.
- Governed executors perform permitted effects; humans ratify consequential writes.

## Build-State Vocabulary

Use these states precisely:

- **Present**: source or schema exists.
- **Wired**: a real caller or data-flow edge exists.
- **Production-proved**: a caller-identity test exercised the behavior and verified
  resulting records, denials, idempotency, audit, and cleanup.
- **Incomplete**: part of the intended operating loop is absent or unproved.

Static Atlas refresh intentionally never sets `exercised=true`. A null exercise
flag is unknown, not failed. Likewise, a table, FK, route, or polished screen is
not proof of an operating workflow.

## Rebuild Method

Before another specialty module is rebuilt:

1. Trace its organization, agreement, place, assignment, evidence, review, and
   reporting anchors through Atlas and schema.
2. Prove the shared resolver and authority paths it depends on. Record any gap
   rather than substituting page defaults or organization-wide fallbacks.
3. Define the state machine and mutation owner. Accepted evidence and lifecycle
   transitions belong behind caller-derived, server-side, idempotent, audited
   boundaries. AI remains advisory unless an explicit governed contract says more.
4. Build officer capture and supervisor review as two views of the same records,
   including unavailable, rejected, retry, conflict, and manual-review states.
5. Validate locally, deploy additively, production-prove with isolated fixtures,
   clean proof data, refresh Atlas, and compare flow reach separately from FK reach.

## Dependency-First Order

The next work should audit shared spines before selecting another specialty page:

1. Tenant/module entitlement and role gates.
2. Organization -> agreement -> agreement-location -> site/zone authority.
3. Roster -> shift -> stop/module -> dispatch/patrol execution.
4. Evidence identity, private storage, access basis, retention, review, and reporting.
5. Welfare truth from field signal through escalation, operator response, and audit.
6. Cross-module person, vehicle, place, and case identity convergence.
7. Bob proposal/approval/execution and Builder release boundaries.

After those checks, rank specialty modules by unresolved shared dependency and risk,
not by menu order or visual incompleteness.