# FCM Platform Architecture Brief

> Read under the canon: [`FOUNDATION.md`](../FOUNDATION.md) and
> [`docs/canon/README.md`](canon/README.md) outrank this brief. This document is
> the working summary of how the platform is shaped; where it is silent or
> disagrees, the canon governs. Reconciled with the GitLab lineage 2026-09-14.

## Product Identity

Field Compliance Manager (FCM) is Iron Eagle Security's New Zealand field operations and compliance platform. It is not merely a CRM and not merely a patrol application. It is a multi-organization, multi-tenant operating system for client organizations, operational places, field services, compliance activity, workforce, roster, dispatch, evidence, finance, and governed administration.

Its purpose is accountability, not compliance for its own sake: record what happened honestly, preserve it faithfully, and prove it to a court standard when it matters. Accountability anchors to the **harmed party and the place of harm**; the subject (offender, vehicle, source place) is anchored separately; the operator is the **custodian of the record, not the owner of the accountability** (`FOUNDATION.md`).

The unifying operational truth: **every field role is a guard on a place for a shift, with a toolset** (`docs/canon/UNIFIED_FIELD_OPERATIONS_MODEL.md`). Static guarding is a patrol with one stop; patrol is a static with many; freedom camping, parking, noise, smoke and biosecurity are the same guard-on-a-place plus one specialty tool. Modules are tools, never the job.

The core product flow is:

1. Manage organizations and client portfolios.
2. Confirm commercial authority and agreements.
3. Manage operational places.
4. Run field, patrol, and compliance activity.
5. Capture observations, evidence, and events.
6. Manage staff, roster, dispatch, readiness, and credentials.
7. Support finance and commercial relationships.
8. Let Bob interpret, correlate, and propose governed actions without silently deciding authoritative truth.

## Canonical Data Spine

- `organizations` is the top-level business entity. Under **Model A** every
  organisation is own-rooted (`parent_organization_id = NULL`) and its role as
  provider or client is contextual per `service_agreement`; the legacy
  parent/child tree is still supported for orgs created under it
  (`docs/canon/ORG_SERVICE_MODEL.md`).
- A place is one **house** (`locations`) with two facets
  (`docs/canon/LOCATION_HOUSE_MODEL.md`):
  - `client_sites`: the addressed Site facet. The name is legacy — read it as
    `sites`; `client_organization_id` is the place's owner org, not
    `organization_id`.
  - `location_zones`: the area/geofenced Zone facet, carrying `module_key`,
    `active_schedule`, `onsite_profile` and `rule_overrides` so one geometry can
    host overlapping, time-aware module rules.
- `location_events` is the intended single place-activity stream (live it is
  present but unwritten — a seam, not a spine, until a governed writer lands).
- `site_services` holds per-place service selection (site XOR zone, `module_key`).
- Boundaries carry `boundary_verification` / `jurisdiction_verification` and are
  not authoritative until visually verified; `resolve_context` returns a
  `resolution_status` rather than a silent empty (`docs/canon/GEOFENCE_PRINCIPLES.md`).
- Other modules reference the organization-and-place spine. They must not invent parallel ownership or location models.
- Auth identity, user identity, CRM business identity, and organizational ownership are distinct concerns.
- Access to sensitive records composes from the three-question test (authorised /
  needs / role) as `operator_custody OR (module_grant AND place_authority AND
  task_signal AND (ownership_derived OR place_relevance))`
  (`docs/canon/ACCESS_DOCTRINE.md`, `docs/canon/ACCESS_MODEL.md`); `observations`
  is the live keystone.

## Domain Boundaries

### CRM and Client Portfolio

Owns commercial and relationship context: organizations, agreements, contacts, roles, module enablement, readiness, and handoff context. CRM is the relationship and entitlement hub, not raw auth authority and not the owner of every platform record.

### Locations

Owns operational place truth, names, addresses, site/zone subtype, geometry, boundaries, geofences, and place-level context. UI should present a place as one concept while making its site or zone subtype clear.

### Operations and Field Activity

The officer application is the live edge. It captures scans, observations, GPS, reports, photos, dispatch outcomes, and evidence-linked operational events. This is where real-world activity enters FCM.

### Workforce

Owns staff, roster, schedules, coverage, readiness, credentials, and eligibility for service delivery. It does not own client or commercial truth.

### Finance

Owns rates, costing, quotes, invoices, and payments. It supports the organization and client portfolio hubs while remaining financial truth.

### Compliance Satellites

Parking, noise, biosecurity, smoke control, CCTV, investigations, dispatch, welfare, vehicles, persons, reports, and related modules hang off shared organizations, agreements, places, staff, events, and evidence. They must not redefine those core concepts independently. A module is a **data profile** over the two engines (geofence and Bob) — place trigger, perception tool, ruleset, outputs, storage — registered into the shared spines through one manifest, never a per-module code branch (`docs/canon/PLATFORM_ENGINES_AND_MODULE_PROFILE.md`, `docs/canon/MODULE_INTEGRATION_CONTRACT.md`). Freedom Camping is the reference build for the vehicle-compliance style.

### Bob

Bob is one of the platform's two engines and one agent (ONE BOB): chat, fleet-wide reasoning, governed operational writes and build/ops work share one identity, memory and governance loop, varying only by the caller's rank and Bob's earned readiness. He thinks fleet-wide and speaks within rank — tenant isolation is enforced at egress by the Conductor, with RLS as the backstop. Bob may interpret source material, search live records, classify likely outcomes, correlate evidence across the fleet (H&S and risk patterns are a headline feature), and prepare governed proposals. Bob must not silently decide legal, commercial, identity-critical, or enforcement truth; high-impact and irreversible writes require human approval, escalated by rank, and are never auto-executed; migrations, auth/RLS, dependencies and deployment are protected paths he may draft but never apply; and auth, identity, governance and audit tables are read-only to him. Every constraint on Bob must implement one of the two rails (rank, NZ Privacy Act) or a load-bearing gate, or carry a recorded owner ruling (`docs/canon/BOB_DOCTRINE.md`).

## UI Direction

The enterprise UI should be calm, focused, queue-driven, and organized around human task flow rather than raw tables or implementation details.

Every workflow should make these states explicit:

- Not started
- Blocked
- Needs input
- Ready
- In progress
- Needs review
- Complete

Show the next required action, blockers, readiness, provenance, and approval gate. Keep future steps visible but locked with plain-language reasons. Use one record spine per organization and client portfolio. Do not expose geofence or schema complexity unless the task requires it.

## Build Rules for Codespace AI

- Treat FCM as a governed multi-domain field operations platform.
- Preserve clear source-of-truth boundaries.
- Do not treat CRM as the owner of everything.
- Do not mix auth identity with CRM business identity.
- Do not create overlapping location truths.
- Do not build isolated module silos with duplicate organization, place, status, or evidence models.
- Make evidence and event provenance first-class.
- Design imports, proposals, approvals, execution, and audit as explicit workflow stages.
- Use Atlas as generated terrain, never as hand-maintained authority.
- Cross-check Atlas claims against schema and real callers before wiring UI behavior.
- Make Bob's read, reasoning, proposal, approval, and execution boundaries visible.
- Keep legal, identity, enforcement, and commercial decisions human-governed.
- Build the UI around operator tasks and operational queues, not internal table names.

## Mental Model

FCM is one coherent platform with a shared organization-and-place spine. CRM owns relationship and commercial context; Locations owns place and geometry truth; Operations owns live events and evidence capture; Workforce owns eligibility and coverage; Finance owns financial truth; compliance modules consume and extend those shared entities as data profiles; Bob reasons across them and proposes governed actions rather than silently deciding. Beneath all of it: a guard, on a place, for a shift, with a toolset — recorded so that the harmed party's accountability outlives any contract.
