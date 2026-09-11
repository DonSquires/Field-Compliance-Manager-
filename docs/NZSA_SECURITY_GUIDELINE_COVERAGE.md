# NZSA Good-Practice Coverage Register

Assessment source: [NZSA New Zealand Security Services Good Practice Guidelines (April 2023)](https://security.org.nz/wp-content/uploads/2023/04/NZSA-NZ-Security-Services-Good-Practice-Guidelines_April-2023.pdf), retrieved 2026-09-11. The source remains the governing reference; this register is not a certification claim.

The FreedomCamp-Manager prototype is process reference only. FCM's canonical organization, place, site, zone, agreement, workforce, evidence, finance, and audit spine remains authoritative.

## Coverage Status

| Guideline domain | FCM surfaces and evidence | Current status | Next discriminating check |
| --- | --- | --- | --- |
| Risk management | Operational places, zones, verified boundaries, closures, readiness, dispatch, breach review | **Partially evidenced**: browser and schema tests cover bounded decisions and closure evidence | Human role walk: confirm a supervisor can review risk, approve an action, and see the audit receipt |
| Security personnel services | Agreements, enabled modules, work units, rosters, dispatch, field reports, debriefs | **Partially evidenced**: agreement-to-roster-to-dispatch path is tested | Trace one real service agreement from scope through completed work and client/report output |
| Personnel and identity | Staff readiness, credentials, branch authorization, role/module grants, welfare controls | **Partially evidenced**: authorization boundaries and officer flows are tested | Verify branch-scoped identity, credential expiry, training status, and deactivation behavior with dedicated roles |
| Training and competence | HR training/credentials, readiness blockers, roster eligibility | **Partial**: schema and readiness contracts exist; end-to-end evidence is limited | Confirm an expired or missing credential blocks new assignment while preserving planning visibility |
| Privacy and information handling | Tenant scope, RLS/RPC boundaries, evidence classification, file intake, redaction controls | **Partially evidenced**: security and schema tests cover many boundaries | Run a cross-tenant negative test for every high-risk read and export surface |
| Complaints and disputes | Investigations, breach outcomes, follow-up, notifications, immutable audit records | **Partial**: outcome and follow-up paths are tested | Walk complaint intake, ownership, response, closure, and retained record end to end |
| Quality and governance | Atlas capability map, migration ledger, audit log, approval gates, human review, receipts | **Partially evidenced**: Atlas and migration synchronization are verified | Attach human observation evidence and owner sign-off to each unresolved gap |
| Health, safety, and emergency response | Officer safety bar, SOS/welfare alerts, site safety notes, debrief and follow-up | **Partially evidenced**: governed RPC and officer safety tests pass | Human test an SOS or welfare escalation and verify acknowledgment, escalation, and closure |

## Measurement Rule

An item is **proven** only when all three stages have evidence:

1. **Before**: role, organization/place context, permissions, source record, and configuration.
2. **During**: visible control, bounded request/RPC, policy check, loading/error state, and audit event.
3. **After**: persisted receipt, derived state, notification/report impact, and what the next actor sees.

Atlas is used to identify capability state and blast radius. Direct reads/writes/calls are evidence of flow; foreign-key adjacency alone is not.

## Current Evidence

- Repository tests and web tests are the executable baseline.
- DR Bob local and live human walks cover rendered navigation and field entry points.
- FCM freedom-camping tests cover scan, closure evidence, vehicle evidence, overnight verification, breach outcome, and unavailable-feed behavior.
- Atlas refresh and migration synchronization must be rerun after changes to shared schema, RPCs, or workflow boundaries.

Open gaps remain assessment work, not an implied compliance result. Human observation, schema/Atlas inspection, and bounded live-read evidence are required before production sign-off.