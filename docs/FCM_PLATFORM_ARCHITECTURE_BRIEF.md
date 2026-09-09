# FCM Platform Architecture Brief

## Product Identity

Field Compliance Manager (FCM) is Iron Eagle Security's New Zealand field operations and compliance platform. It is not merely a CRM and not merely a patrol application. It is a multi-organization, multi-tenant operating system for client organizations, operational places, field services, compliance activity, workforce, roster, dispatch, evidence, finance, and governed administration.

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

- `organizations` is the top-level business entity.
- Operational places are one domain with two primary representations:
  - `client_sites`: addressed physical sites. Ownership uses `client_organization_id`, not `organization_id`.
  - `location_zones`: area-based or geofenced operational zones.
- `location_events` holds place activity and event context.
- `site_services` holds per-place services.
- Other modules reference the organization-and-place spine. They must not invent parallel ownership or location models.
- Auth identity, user identity, CRM business identity, and organizational ownership are distinct concerns.

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

Parking, noise, biosecurity, smoke control, CCTV, investigations, dispatch, welfare, vehicles, persons, reports, and related modules hang off shared organizations, agreements, places, staff, events, and evidence. They must not redefine those core concepts independently.

### Bob

Bob is a reasoning, correlation, and proposal layer over the platform. Bob may interpret source material, search live records, classify likely outcomes, correlate evidence, and prepare governed proposals. Bob must not silently decide legal, commercial, identity-critical, or enforcement truth. High-impact writes require the appropriate human approval. Bob never runs DDL and never writes to auth, identity, governance, or audit tables.

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

FCM is one coherent platform with a shared organization-and-place spine. CRM owns relationship and commercial context; Locations owns place and geometry truth; Operations owns live events and evidence capture; Workforce owns eligibility and coverage; Finance owns financial truth; compliance modules consume and extend those shared entities; Bob reasons across them and proposes governed actions rather than silently deciding.
