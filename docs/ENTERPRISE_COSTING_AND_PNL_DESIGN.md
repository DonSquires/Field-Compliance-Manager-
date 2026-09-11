# Enterprise Costing And P&L Design

## Purpose

Build an enterprise-grade provider finance capability for Field Compliance Manager (FCM) that answers two operational questions:

1. What does this service actually cost to deliver?
2. What price and margin should be proposed to the client?

The system is for quoting, service-cost control, operational margin, and management P&L. It is not a replacement for a certified payroll, tax, statutory accounting, or general-ledger product unless those capabilities are separately designed, implemented, reconciled, and certified.

The FreedomCamp-Manager prototype is reference material only. Its `CostIntelligencePanel` demonstrates the useful direction, but its browser-local provider cost inputs, flat overhead assumption, and estimated totals are not enterprise-grade accounting evidence.

## Design Principles

- FCM's organization, operating branch, client portfolio, agreement, location, site, zone, staff, roster, dispatch, evidence, and audit spines remain canonical.
- Internal true cost and client-visible commercial price are separate confidentiality domains.
- Every amount has a currency, effective period, source, owner, status, and version.
- Forecast, quote, committed, incurred, invoiced, collected, and reconciled are different measures.
- Accepted quotes retain immutable commercial and cost assumptions; later actuals create variance, not silent rewrites.
- A calculation without source evidence is an estimate and must be visibly labelled.
- Sensitive payroll, bank, HR, and supplier data is minimized and never exposed to clients or Bob by default.
- Bob may explain and propose; authorized humans approve cost models, rates, allocations, and financial actions.
- All writes use governed RPCs or approved import paths with idempotency and audit receipts.

## Primary Users And Decisions

| User | Decision | Visibility |
| --- | --- | --- |
| Provider commercial manager | Set price, target margin, scope, assumptions, and quote version | Cost and price for authorized provider branches |
| Operations manager | Confirm staffing, travel, vehicle, equipment, and delivery assumptions | Operational costs and scenario detail |
| Finance manager | Approve cost model versions, allocations, invoices, payments, and reconciliation | Full finance scope for authorized organizations |
| Payroll/HR manager | Maintain pay rates, leave/on-cost assumptions, and staff cost inputs | Staff-sensitive cost data; no client commercial controls unless granted |
| Branch manager | Review branch P&L and approve branch costing within delegation | Own branch and allowed consolidated views |
| Client user | Review agreed price, invoice, service outcome, and allowed contract cost sharing | Never internal wages, overhead formulas, or unrelated organizations |
| Bob | Summarize evidence, identify missing inputs, propose scenarios | Bounded aggregate context; no raw payroll, bank, or confidential rows |

## Cost Model

### 1. Loaded labour cost

For each staff cost profile and effective period:

`loaded labour hourly cost = base wage + overtime/public-holiday premiums + KiwiSaver + ACC/workplace levy + payroll cost + leave provision + training/induction + uniform/PPE allocation + other employment benefits`

Recommended inputs:

- base hourly rate or salary converted to productive hours
- employment type and ordinary hours
- overtime and public-holiday multipliers
- employer KiwiSaver contribution rate
- ACC/workplace injury levy assumption
- annual leave provision
- sick leave provision
- bereavement, family violence, parental, and other special leave provision where applicable
- paid training, induction, supervision, meeting, and non-billable administration
- uniform, PPE, licensing, medical, and competency costs
- payroll processing and HR administration allocation
- productive-hours denominator and utilization assumption

The model must not assume that paid hours equal billable hours. It should show both paid availability and productive/billable utilization.

### 2. Vehicle and travel cost

Support both fixed standing cost and variable distance cost:

`vehicle hourly standing cost = annual fixed vehicle cost / productive vehicle hours`

`vehicle per-km cost = fuel + maintenance + tyres + distance-linked running costs per kilometre`

`trip cost = standing cost for allocated hours + per-km cost * verified kilometres`

Recommended inputs:

- purchase price, finance/lease principal, interest, and term
- depreciation method and useful life for management reporting
- registration, licensing, WoF/CoF, and inspection costs
- insurance and roadside assistance
- fuel type, consumption litres/100km, fuel price, and fuel card fees
- servicing, repairs, scheduled maintenance, and breakdown provision
- tyres and replacement cycle
- cleaning and consumables
- GPS, telematics, tolls, parking, and road-user charges where applicable
- availability, utilization, and productive hours

A vehicle rate must be versioned. Actual odometer/fuel/service records can later produce variance against the approved model.

### Depreciation and asset cost

Depreciation is a management-cost input, not a value the user should calculate manually. The user should enter the source facts:

- asset and owner organization
- purchase date and placed-in-service date
- acquisition cost and directly attributable setup cost
- residual/salvage value assumption
- useful life in months or expected operating hours/kilometres
- depreciation method approved for the model
- finance/lease treatment where applicable
- current meter, utilization, and disposal date if retired

The system can then calculate and show the schedule. A common management method is straight-line depreciation:

`annual depreciation = (capitalized cost - residual value) / useful life years`

`monthly depreciation = annual depreciation / 12`

`depreciation per productive hour = annual depreciation / productive asset hours`

`depreciation per kilometre = depreciable cost / expected useful-life kilometres`

The design should also support declining-balance and units-of-production methods when finance approves them. The calculation must show method, assumptions, start date, accumulated depreciation, carrying value, remaining life, and allocation driver. It must not silently present a tax depreciation result as an accounting result; tax treatment and management costing are separate policies.

Agentic assistance should explain the result and flag missing or unusual inputs, for example residual value above cost, useful life of zero, implausible utilization, or an asset used by multiple branches without an allocation rule. It may propose a method or benchmark, but a finance owner must approve the assumption before it affects a quote or locked P&L period.

### 3. Equipment and evidence cost

Allocate radios, body cameras, phones, tablets, uniforms, PPE, batteries, software, mobile data, storage, and evidence retention by one explicit driver:

- per staff member
- per vehicle
- per shift hour
- per field visit
- per evidence item
- direct assignment to a service unit

### 4. Office and operating cost

Capture recurring and one-off costs such as premises, utilities, telecommunications, software, recruitment, legal, accounting, training facilities, consumables, insurance, audit, and administrative labour.

Each cost must identify:

- owner organization and cost centre
- cost category and subcategory
- fixed/variable classification
- direct/indirect classification
- allocation driver
- effective dates
- source document or approved import
- review frequency

### 5. Corporate overhead

Overhead must be allocated by a declared driver, not an unexplained percentage. Supported drivers should include:

- productive labour hours
- headcount or FTE
- revenue
- vehicle hours or kilometres
- service visits
- active contracts
- direct cost proportion
- manual allocation percentage with approval and reason

The UI must show the driver, denominator, allocated amount, and unallocated balance.

## Quote Calculation

For each quote version and service scope:

`true service cost = loaded labour + vehicle/travel + equipment + direct operating cost + allocated overhead`

`minimum viable charge = true service cost + required risk buffer`

`proposed charge = max(minimum viable charge, target-margin charge, approved commercial floor)`

`gross margin = proposed charge - true service cost`

`gross margin % = gross margin / proposed charge * 100`

Every quote should show:

- scope, place, service module, work model, schedule, and expected volume
- staffing and role assumptions
- loaded labour breakdown
- travel route, kilometres, and vehicle assumption
- equipment and evidence cost
- direct costs
- overhead allocation
- risk/contingency allowance
- client charge and GST treatment
- gross margin amount and percentage
- missing, estimated, or stale inputs
- effective cost-model version
- approval state and approver

A quote cannot be sent when required cost inputs are missing unless an authorized user explicitly approves an estimate exception with a reason and expiry.

## Management P&L

Management P&L should be available by month and drillable by:

- organization and operating branch
- client portfolio and service agreement
- location, site, zone, and service module
- work unit, shift, dispatch job, and report period
- cost centre and workplace
- staff role or anonymized staff cost group
- vehicle and fleet category
- revenue category and invoice

Minimum statement:

- recognized service revenue
- discounts and credits
- direct labour cost
- labour on-costs
- vehicle/travel cost
- equipment/evidence cost
- direct operating cost
- allocated operating overhead
- gross profit
- gross margin percentage
- unallocated overhead
- operating expenses
- operating profit/loss
- forecast versus actual variance
- invoiced versus collected balance

P&L rows must carry a measurement basis such as `forecast`, `quoted`, `committed`, `incurred`, `invoiced`, `collected`, or `reconciled`. Do not add these figures together as if they were the same accounting measure.

## FCM-Native Data Model

Use existing sources where they already have the correct authority:

- `staff_profiles`, `staff_credentials`, `timesheets`, `leave_requests`, training/readiness records
- `dispatch_job_pay_lines`, `roster_slots`, `shifts`, `timesheet_work_entries`
- `assets`, `asset_checks`, canonical vehicle and fleet records
- `organization_workplaces`, `cost_centres`, `roster_work_units`
- `rate_rules`, `crm_commercial_settings`, `site_financial_config`
- `quotes`, `quote_lines`, `invoice_line_items`, `invoices`
- `service_agreements`, `service_agreement_locations`, `service_agreement_modules`
- `audit_log`, approval records, evidence and source-document provenance

Add a governed finance layer for the missing durable concepts:

## Business Units And Extensible Modules

The current `module_catalog` is the correct starting point, but a module key alone is not enough for an enterprise product. Each business unit should be data, configuration, and governed capabilities rather than a new hard-coded branch in the UI.

Examples include:

- current security, patrol, static guarding, freedom camping, parking, noise, biosecurity, smoke control, dispatch, and investigations
- manufacturing and production operations
- forestry patrol and remote-site operations
- forest pest and animal control
- CCTV and investigation extensions

Recommended entities:

### `business_unit_catalog`

Platform-owned capability definition: key, display name, description, domain, icon/branding reference, lifecycle, required roles, safety classification, and supported workflow capabilities. This is catalog metadata, not tenant enablement.

### `organization_business_units`

Organization-owned enablement: organization, business unit, status, effective dates, configuration version, operating boundaries, and owner. Enabling a unit does not grant every user access.

### `business_unit_capabilities`

Data-driven capability registry: business unit, capability key, workflow type, source entities, required permissions, evidence requirements, and configuration schema. New units can declare workflows without changing shared identity, agreement, place, staff, evidence, or audit spines.

### `agreement_business_units`

The commercial contract boundary: agreement, enabled business unit, client visibility mode, service scope, pricing basis, reporting obligations, and approval state. Existing `service_agreement_modules` can remain a compatibility projection during migration.

### `organization_business_unit_settings`

Tenant configuration as versioned JSON/schema-backed settings with validation, owner, effective dates, and audit history. Do not put unit-specific columns on shared tables unless the field is genuinely canonical.

The UI should load the catalog and capability metadata, then render generic workflows for shared actions. Unit-specific forms should be schema-driven and routed through a declared capability contract. Unknown, disabled, or unauthorized capabilities must fail closed with a useful explanation.

## Parts, Materials, Consumables, And Inventory

Manufacturing, forestry, pest control, CCTV, and field security can all consume parts, materials, fuel, PPE, bait, traps, batteries, uniforms, signage, or other stock. These are both operational records and service-cost inputs.

Recommended entities:

### `item_catalog`

Organization-scoped or shared item definition: SKU, name, item type, unit of measure, tax treatment, hazardous/controlled flag, reorder point, preferred supplier, and active dates. Item types include part, material, consumable, fuel, PPE, equipment component, and service.

### `item_cost_versions`

Versioned cost basis: item, unit cost, currency, source, supplier, effective dates, landed-cost components, and approval state. Preserve historical cost; never rewrite an old service calculation with today's price.

### `inventory_locations` and `inventory_balances`

Warehouse, depot, vehicle, branch, site, or technician stock location with on-hand, reserved, available, and quarantine quantities. All movements must be append-only transactions.

### `inventory_transactions`

Receipt, issue, return, transfer, adjustment, write-off, consumption, and quarantine events with item, quantity, unit cost, source document, actor, organization, location, work order/service unit, and idempotency key.

### `service_item_consumption`

Links issued or consumed items to agreement, location/site/zone, work unit, shift, dispatch job, investigation, manufacturing job, pest-control job, or invoice line. This is the bridge from materials to true service cost.

### `asset_item_links`

Links parts and maintenance materials to an asset, vehicle, equipment record, service event, and asset meter. Asset Management remains the operational owner; Finance consumes approved cost events.

The costing calculator should support estimated material quantities for quotes, approved reservations for scheduled work, and actual consumption after delivery. Variance must show estimated quantity/cost versus actual quantity/cost.

## Asset Management Integration

Asset Management is a shared upstream source, not a separate finance island:

- **HR** maintains staff assignment eligibility and accountable custodians where appropriate.
- **Operations** records allocation to vehicles, equipment, sites, shifts, and work units.
- **Asset Management** owns inspections, defects, service intervals, odometer/meters, lifecycle, and maintenance events.
- **Finance** owns cost rates, depreciation/finance assumptions, capitalization policy, allocation, and P&L treatment.
- **Audit** records assignment, custody, maintenance approval, write-off, and cost-model use.

An asset cost event should be attributable to the asset, cost centre, service unit, and period. Fuel and distance can feed variable vehicle cost; servicing, tyres, insurance, finance, depreciation, and registration feed fixed or scheduled cost. `asset_checks` are evidence of condition and availability, not by themselves a financial transaction.

## Investigation And Canonical Entity Extensions

Investigations should extend the existing investigation system, not create a second intelligence spine. CCTV, observations, evidence, vehicles, people, and incidents should link through governed canonical records and retain their source provenance.

The same rule applies to VOI, POI, and LOI:

- canonical vehicle/person/place records remain the identity anchors
- organization-scoped flags and links carry the business context
- evidence and investigation links carry why the association exists
- human review is required before promotion from candidate to authoritative relationship
- business-unit workflows declare which canonical entities they read or write

An investigation or field service can consume materials, staff time, vehicle time, and evidence storage, so `service_item_consumption` and finance allocations must support investigation IDs without duplicating the investigation record.

### `finance_cost_categories`

Organization-scoped category tree: labour, labour-on-cost, vehicle, equipment, office, corporate overhead, contingency, and other. Includes direct/indirect, fixed/variable, tax treatment, and active dates.

### `finance_cost_assumptions`

Versioned assumptions owned by an organization/cost centre: amount, unit, currency, driver, effective period, source reference, confidence, approval state, and supersession link.

### `finance_staff_cost_profiles`

Sensitive staff cost model separate from identity: pay basis, productive-hours denominator, on-cost rates, leave provisions, training/uniform allocations, effective dates, and approval metadata. Store only what is needed; do not duplicate bank or tax identifiers.

### `finance_vehicle_cost_profiles`

Vehicle or fleet-class cost model: fixed annual costs, variable per-km costs, fuel assumptions, utilization, depreciation/finance treatment, effective dates, and source evidence.

### `finance_asset_cost_profiles`

Versioned asset costing facts linked to `assets`: capitalization status, acquisition cost, setup cost, residual value, useful life, depreciation method, in-service date, expected productive hours/kilometres, allocation policy, and approval state. Asset Management remains the source of operational lifecycle and meter evidence.

### `finance_asset_depreciation_schedules`

Generated immutable schedule versions: period, opening carrying value, depreciation, accumulated depreciation, closing carrying value, method, source profile version, and allocation result. Corrections create a new schedule version or adjustment; old schedules are retained.

### `finance_overhead_allocations`

Approved allocation rules and period runs: source cost centre, target dimension, driver, denominator, amount, version, and approval receipt.

### `finance_cost_model_versions`

Immutable approved scenario/version containing the selected assumptions and allocation rules. Used by quote versions and P&L runs.

### `finance_cost_model_lines`

Normalized calculation output linked to a model version and source dimension. Records quantity, unit cost, amount, source type/id, basis, and confidence.

### `finance_quote_cost_snapshots`

Immutable cost snapshot attached to a quote/version. Stores calculated cost lines, charge, margin, assumptions, and unresolved-input decisions.

### `finance_actual_cost_entries`

Append-only actual cost entries from approved sources: payroll/timesheet, leave provision, vehicle transaction, equipment, supplier/office expense, allocation run, or adjustment. Supports source hash and idempotency key.

### `finance_service_cost_allocations`

Maps actual/committed cost to agreement, location, site, zone, work unit, shift, dispatch job, invoice line, or cost centre. No polymorphic link is accepted without a constrained source type and existence check.

### `finance_periods`

Organization-scoped period controls: open, review, locked, reopened-with-approval, and closed. Prevent edits to locked results; corrections are adjustment entries.

### `finance_pnl_lines`

Generated management P&L rows with basis, period, dimension, source totals, calculation version, and reconciliation status. Rebuildable from immutable entries, not hand-edited totals.

### `finance_payments` and `finance_payment_allocations`

When payment tracking is intentionally built: receipt transaction, payer, received date, amount, method, reference, approval/reconciliation state, and explicit allocations to one or more invoices. Never infer payment from invoice status alone.

### `finance_adjustments`

Controlled credit, refund, write-off, reclassification, and correction entries with reason, approver, source, period, and reversal relationship.

## Security And Privacy

- Internal cost tables are provider/branch scoped with RLS and RPC-only writes.
- Payroll/HR roles see staff cost profiles; commercial roles see aggregated loaded rates unless delegated.
- Clients see only accepted price, invoice, permitted cost-sharing fields, and service outcomes.
- Bank account, tax code, personal identifiers, and raw payroll data stay outside Bob context and client projections.
- Cost-model reads return bounded aggregates and source references, not unrestricted row dumps.
- Every approval, override, import, period lock, reopening, payment allocation, and adjustment creates an audit event.
- Cost snapshots are immutable after quote acceptance.
- Exports require purpose, role, period, organization scope, and retention classification.

## Workflow Lifecycle

1. **Draft scenario**: commercial or finance user selects agreement, place, service module, work model, staffing, vehicle, and assumptions.
2. **Calculate**: server computes cost lines, margin, missing inputs, and confidence.
3. **Review**: authorized human reviews source evidence, allocation drivers, and exceptions.
4. **Approve version**: finance owner approves the cost-model version with effective dates.
5. **Prepare quote**: quote references the approved model and immutable cost snapshot.
6. **Send/accept**: commercial lifecycle remains separate from internal cost data.
7. **Deliver**: roster, dispatch, timesheet, travel, vehicle, and evidence events create committed/incurred entries.
8. **Invoice**: invoice lines reference service scope and accepted commercial terms.
9. **Collect/reconcile**: payment receipt and allocation are separate from invoice status.
10. **Close period**: P&L is generated, reviewed, locked, and reopened only through an audited correction path.

## Implementation Phases

### Phase 1: Quote Cost Calculator

- Provider-only workspace inside Finance/Client Portfolio context.
- Read existing agreement, quote, rate, work-unit, roster, pay-line, vehicle, and cost-centre data.
- Add scenario inputs and server-calculated cost lines.
- Show loaded labour, travel, overhead, charge, margin, missing inputs, and confidence.
- Store immutable quote cost snapshot.
- Include approved depreciation-derived vehicle and equipment rates where available; show an explicit estimated/missing-input state otherwise.

### Phase 2: Approved Cost Models

- Add category, assumption, staff cost, vehicle cost, overhead, and model-version tables.
- Add approval and effective-date lifecycle.
- Add source-document and import provenance.
- Add branch and cost-centre scope.
- Add asset cost profiles and generated depreciation schedules.

### Phase 3: Actual Cost Capture

- Convert completed payroll/timesheet and dispatch pay evidence into actual cost entries.
- Add vehicle transaction and equipment allocation imports.
- Add idempotent source mapping and variance against quote snapshots.

### Phase 4: Management P&L

- Add period controls and generated P&L lines.
- Add agreement/site/work-unit/branch dimensions.
- Add forecast-versus-actual and quoted-versus-invoiced views.
- Add exports with purpose and retention controls.

### Phase 5: Payments And Reconciliation

- Add payment receipts, allocations, credits, refunds, write-offs, and reconciliation states.
- Integrate with an approved accounting provider only after an explicit connector contract and retry/audit design.
- Do not label invoices paid from an external sync until the receipt is verified.

## Acceptance Criteria

A first production-worthy quote calculator must prove:

- correct organization and branch scope
- agreement/place/site/work-unit attribution
- loaded labour calculation with effective dated assumptions
- vehicle hour and per-km calculation
- overhead driver and denominator
- explicit unknown/estimated/stale inputs
- quote cost snapshot immutability
- target margin and commercial floor enforcement
- GST treatment shown separately from margin
- human approval and audit receipt
- downstream quote and invoice continuity
- no client exposure of internal cost details
- desktop and mobile usability
- Atlas capability and flow edges refreshed after schema/RPC changes

## Primary References

- NZSA, [New Zealand Security Services Good Practice Guidelines (April 2023)](https://security.org.nz/wp-content/uploads/2023/04/NZSA-NZ-Security-Services-Good-Practice-Guidelines_April-2023.pdf)
- Inland Revenue, [KiwiSaver for employers](https://www.ird.govt.nz/kiwisaver/employers)
- Employment New Zealand, [Leave and holidays](https://www.employment.govt.nz/leave-and-holidays)
- ACC, [Levies](https://www.acc.co.nz/for-individuals/other-people/levies)
- Waka Kotahi NZ Transport Agency, [Vehicle licensing and registration](https://www.nzta.govt.nz/vehicles/licensing-rego/)

These references support the categories and governance questions. They do not by themselves determine the organization's legal, payroll, tax, accounting, or employment treatment. Finance and employment specialists must approve the final rules and rates.
