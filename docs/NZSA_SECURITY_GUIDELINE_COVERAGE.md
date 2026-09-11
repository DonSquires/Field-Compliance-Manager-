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

## Finance Boundary

The current schema provides a governed commercial billing foundation:

- `quotes` and `quote_lines`
- `rate_rules`, commercial settings, and site financial configuration
- `invoices`, `invoice_line_items`, and reusable invoice line templates
- GST and total calculations
- invoice lifecycle actions for send, paid, and void
- audit entries and approval-gated finance reconciliation proposals

It is not yet a complete accounting or finance system. The schema does not currently provide a dedicated payment/receipt ledger, allocations against invoices, credit notes, refunds, expenses, supplier bills, bank reconciliation, tax-period/GST return ledger, general ledger journals, or financial reporting controls. The UI must therefore describe invoice `paid` status as an operational record, not proof of reconciled settlement.

For production assessment, mark finance as **partial** until those missing records, governed commands, permissions, audit events, and reconciliation reports are intentionally designed and tested. Do not add those entities merely to make the screen appear complete; trace the required finance job and source evidence first.

## Quoting And True-Service Cost

The next finance build should be a provider-only **Costing and P&L** workspace. It should feed quote preparation and service-cost review, while keeping client-visible prices and internal actual costs separately permissioned.

### Cost categories

- **Direct labour**: base wages, overtime, public-holiday and higher-duties premiums, employer KiwiSaver, ACC/workplace levies, payroll costs, annual-leave loading, sick leave, bereavement/special leave allowance, training/induction time, supervision, uniforms, PPE, and other employment benefits.
- **Vehicle and travel**: fuel, registration, WOF/COF, insurance, finance/lease, depreciation, servicing, repairs, tyres, cleaning, tolls, parking, and GPS/telematics. Support both hourly standing cost and per-kilometre running cost.
- **Equipment and evidence**: radios, body cameras, phones, software, data plans, batteries, storage, replacement, and evidence retention.
- **Office and operations**: premises, utilities, communications, software subscriptions, finance/admin time, recruitment, legal/accounting, training facilities, and consumables.
- **Corporate overhead**: management, HR, compliance, marketing, insurance, audit, technology, and other shared costs allocated by an explicit driver such as labour hours, headcount, revenue, vehicles, or service units.

### Calculation boundary

For each quote or service unit, calculate:

`true service cost = loaded labour + vehicle/travel + equipment + direct operating cost + allocated overhead`

`gross margin = client charge - true service cost`

`gross margin % = gross margin / client charge * 100`

The model must retain the rate-version and allocation assumptions used at quote time. Later actuals must not silently rewrite an accepted quote snapshot. Forecast, quoted, incurred, invoiced, collected, and reconciled amounts are separate states.

### FCM implementation direction

Use existing `staff_profiles`, `timesheets`, `leave_requests`, `dispatch_job_pay_lines`, `assets`, `asset_checks`, `cost_centres`, `roster_work_units`, `rate_rules`, `crm_commercial_settings`, `quote_lines`, and `invoice_line_items` as source or attribution edges. Add a governed cost-model layer only where the current schema has no durable home for assumptions, versioning, allocations, or actual transactions. The Costing workspace should support scenario inputs first, then approved versioning, then service-level and organization-level P&L reports.

The first useful screen is not a generic accounting dashboard. It is a provider quote calculator showing staffing assumptions, loaded labour cost, vehicle cost, overhead allocation, proposed charge, margin, and unresolved cost inputs before a quote can be sent.

The full enterprise design is recorded in [ENTERPRISE_COSTING_AND_PNL_DESIGN.md](ENTERPRISE_COSTING_AND_PNL_DESIGN.md).

## Current Evidence

- Repository tests and web tests are the executable baseline.
- DR Bob local and live human walks cover rendered navigation and field entry points.
- FCM freedom-camping tests cover scan, closure evidence, vehicle evidence, overnight verification, breach outcome, and unavailable-feed behavior.
- Atlas refresh and migration synchronization must be rerun after changes to shared schema, RPCs, or workflow boundaries.

Open gaps remain assessment work, not an implied compliance result. Human observation, schema/Atlas inspection, and bounded live-read evidence are required before production sign-off.