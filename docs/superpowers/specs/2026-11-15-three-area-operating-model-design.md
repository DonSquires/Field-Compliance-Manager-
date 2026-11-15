# Three-Area Operating Model and Background Automation

**Status:** Approved by owner, 2026-11-15  
**Date:** 2026-11-15

## Intent

Make FCM straightforward for people to use while routine work is handled
reliably in the background. Organise the administrative experience around
three areas: **Client Data & Setup**, **Workforce**, and **Finance**. Connect
their work through consistent client, place, staff, shift, and finance records
instead of making users navigate disconnected module pages.

The current operating scope is one service provider, serving multiple client
organisations. Do not expand provider onboarding or build a multi-provider
SaaS product in this phase. Keep the product data-driven and do not scatter
the current provider's identity through UI and workflow logic.

## Users and responsibilities

- **Provider administrator / operations lead:** sets up client records and
  service delivery, manages people and rosters, and resolves operational
  exceptions.
- **Workforce or payroll administrator:** maintains employment records,
  reviews staff hours, and manages payroll according to their existing
  authority.
- **Finance administrator:** maintains commercial rules, quotes and invoices,
  and reviews the financial outcomes of completed work.
- **Field staff:** use the existing field experience to see assigned work and
  record attendance and evidence; this design does not collapse the field
  portal into the administrative workspaces.
- **Client user:** sees only the client-scoped information and actions already
  authorized for that client. Simplifying navigation must not widen disclosure.

The same person may hold more than one role. The UI should show the next
relevant action without implying that one role can make another role's
decisions.

## Goals

1. Provide three stable administrative areas:
   - **Client Data & Setup:** client organisations, contacts, places, service
     relationships and the operational setup required to deliver work.
   - **Workforce:** staff profiles, HR, readiness, rostering, shift coverage,
     and timesheet review.
   - **Finance:** payroll, costing, quoting, invoicing, payment and
     reconciliation workflows.
2. Keep context when users move between areas. A staff shift should resolve to
   the employer, client, place, service authority, and financial records that
   govern it, without asking users to enter the same facts again.
3. Make the ordinary path short and clear. Show work that needs a decision,
   explain blockers in plain language, and reveal supporting detail only when
   it is needed.
4. Let pre-approved rules automatically apply routine, reversible work.
   People can review, edit, cancel, or approve within their authority.
   Exceptions and high-impact decisions remain with people.
5. Make background work observable: show status, source, rule/version, result,
   owner, retry or recovery path, and a receipt. A failed or delayed process
   must never look complete.
6. Preserve tenant, role, privacy, audit, provenance, employment, financial,
   and field-safety controls while simplifying navigation.
7. Prefer one authoritative record per real business concept. Reconcile
   overlapping organisation and place representations only after tracing their
   actual writers, readers, permissions, history, and downstream uses.
8. Use configurable catalogues and rules for services, place types, pay,
   billing, and workflow options where a governed data source exists. Do not
   add another UI-only hard-coded catalogue.

## Non-goals and anti-goals

- Do not enable provider self-sign-up, provider-to-provider handover, or
  multi-provider tenant onboarding in this phase.
- Do not treat this as authorization for a big-bang schema replacement or
  destructive data cleanup.
- Do not remove specialist field workflows or safety steps solely to reduce
  navigation.
- Do not combine employee wages, loaded labour cost, and client charges into
  one amount or use one as a proxy for another.
- Do not silently auto-approve employment, payroll release, quotes, invoices,
  client disclosure, or other high-impact outcomes.
- Do not let Bob or a background worker make an unreviewed legal, employment,
  safety, identity, or consequential financial decision.
- Do not weaken existing access rules to make a shared page easier to wire.

## Approaches considered

1. **Simplify existing pages and labels only.** This is the least disruptive,
   but leaves users to move between separate client, workforce, timesheet,
   payroll, costing, and billing paths. It does not address the fragmentation
   the user described.
2. **Replace the domain model and schema in one release.** This could produce
   a uniform model quickly in theory, but it carries unacceptable risk to
   historical staff, client, place, shift, finance, and audit records and to
   the many existing readers and writers.
3. **Staged, domain-first consolidation.** This is the selected approach.
   Agree the human concepts and ownership first; map existing records and
   writers to them; simplify the three workspaces around real tasks; then
   make only the schema changes proven necessary. Migrate by bounded workflow,
   preserving history and providing tested compatibility or an explicit
   cutover. This improves the UI and the underlying model without making
   release depend on a speculative rewrite.

## Confirmed product decisions

- Use **three** administrative areas: Client Data & Setup, Workforce, and
  Finance.
- Keep a **single service provider for the current phase** and multiple client
  organisations. Revisit multi-provider SaaS only after this product is
  working and the owner reopens that scope.
- Auto-apply routine actions only under explicit, pre-approved rules.
  Authorised people retain review, edit, cancel, and approval controls;
  exceptions and high-impact decisions require human handling.
- The previous timesheet-only design is no longer the overall product design.
  Its verified current-state evidence remains useful when the Workforce
  workflow is designed.

## Proposed experience

### Client Data & Setup

Start from a client list and a client profile that brings together the
organisation, contacts, service relationship, places, and delivery setup.
Basic client identity should not require the administrator to configure every
contact, price, schedule, or portal invitation first. The profile should make
the client and selected place explicit and offer the next relevant setup action.

Present a physical or operational place as one understandable **place** in the
ordinary workflow. Retain site, zone, boundary, address, and jurisdiction
distinctions in the underlying records only where they change safety,
authorization, geography, service, or evidence behavior. Do not merge records
by similar names or proximity. The implementation plan must determine whether
the existing location registry and its site/zone facets represent the simplest
safe model or whether a governed consolidation is needed.

Agreements and service configuration belong with the client/place setup
context; quoted and approved commercial amounts, invoices, and payments remain
Finance records. A setup workflow may link to Finance but must not silently
create a price or treat a draft quote as an approved rate.

### Workforce

Use the staff profile as the person-specific hub for employer-owned identity,
employment setup, credentials, skills, training, readiness, and documents.
Keep login identity distinct from the employment record. Rostering and
timesheet queues remain task-oriented: a profile links to them, and a roster or
timesheet links back to the relevant staff member and place.

Completed work should supply timesheet evidence and derived hours in the
background. Staff can respond to a rejection, but an official correction and
payroll decision remain with an authorized reviewer. Preserve original
attendance separately from an approved payable correction.

### Finance

Bring the relevant financial tasks into one coherent entry point without
turning it into an undifferentiated ledger screen. People should be able to
follow a completed shift or service through its eligible labour cost, quote or
billing basis, invoice, and reconciliation state.

Keep three different measures distinct:

- **Wages:** what the employer owes staff under the applicable pay rules.
- **Cost of service:** the approved loaded labour cost attributed to delivered
  work.
- **Client charge:** the commercial amount due under the approved quote,
  agreement, and billing rules.

Payroll, quotes, invoices, payments, and cost postings must retain their
existing authority and audit receipts. A shared context does not imply shared
permissions or a single financial transaction.

### Background automation and human control

The proposed default is: the system prepares and applies ordinary, pre-approved
actions; it presents a clear receipt and a way to inspect or correct them.
Humans can review, edit, cancel, or approve where authorized. The system routes
ambiguous, conflicting, stale, unauthorized, or otherwise exceptional cases
to a human queue rather than guessing.

For each automated action, the implementation plan must define:

- the pre-approved rule, owner, scope, effective period, and version;
- the triggering source and expected preconditions;
- idempotency, concurrency behavior, and recovery after a lost response;
- whether the action is reversible, cancelable, or requires a compensating
  audited action;
- the receipt, notification, exception owner, and next actor;
- which actions may auto-apply and which always require human approval.

The phrase “auto-apply routine actions” does not authorize automatic release
of payroll funds, acceptance of a quote, sending an invoice, employment
decisions, changes to client/place ownership, disclosure of client data, or
other high-impact actions. Those boundaries must be explicit in the approved
rules.

### Navigation and interaction

The three areas are the primary administrative navigation, not a requirement
to move every existing route or portal. Each area opens on the user's next
action or a concise queue; it should not start with implementation terminology
or a wall of tables. Deep links remain useful for an exact staff, client, place,
shift, timesheet, quote, or invoice, preserving authorized context.

The design follows the existing operational product language and tokens; this
is an information-architecture and workflow consolidation, not a visual
rebrand. Each affected surface still needs responsive behavior and explicit
loading, empty, partial, error, permission, stale, blocked, success, and
recovery states. Status is communicated with text and semantics, not colour
alone.

## Current-state evidence

- `AdminShell.tsx` already groups navigation into Workforce, Clients & Delivery,
  and Finance, but the user-facing destinations are numerous: Rosters,
  Timesheets & approvals, People; Clients, Agreements & services, activation,
  handoffs; and several finance destinations. Field Operations and role-specific
  portals remain additional product contexts.
- `FinanceMoneyPage.tsx` presents a workflow switcher with separate overview,
  completed work, reconciliation, actual labour, job cost, tax, budgets, period
  controls, and guidance, plus separate links for costing and pricing. This is
  operational capability, but not yet a simple cross-workflow task path.
- `ClientSetupPage.tsx` combines client/place/service setup and contains local
  service and place-type lists. The design should trace their sources and
  replace hard-coded options only where a governed catalogue is available.
- `TimesheetsPage.tsx` already contains shift review, commercial readiness, and
  attendance exceptions; timesheets feed both payroll and finance but do not
  by themselves resolve every cost or client billing state.
- The existing `locations`, site, and zone model is detailed and has
  authorization and geometry consequences. The UI may be simplified without
  prematurely erasing distinctions that are load-bearing for evidence,
  boundaries, or access.
- The current Vibe dashboard lists VB-15 as Ready with two changed files and no
  PR. Its visible source excerpt shows Approve and Cancel handlers that only
  display a notice. A passed browser walk does not make those actions
  functional; VB-15 is not accepted or shippable on that evidence.

These are source/document observations, not proof that each flow has been
exercised in production. Atlas and the live schema must be rechecked before
implementation; flow edges and structural relationships must remain distinct.

## Constraints and invariants

- Keep accountability, honest evidence, auditability, and people-first safety
  as the provisional product purpose. This design reopens detailed architecture
  rules; it does not assume the owner has withdrawn the mission.
- Keep the current one-provider business scope for this phase. Client
  organisations remain distinct records; the administrator's provider
  identity is configuration/context, not duplicated in every UI option.
- Preserve the current role/tenant checks and client-disclosure boundaries.
  Staff wages and provider-private commercial data are not exposed to clients.
- Keep staff employment ownership separate from the operational place where
  staff deliver work.
- Keep one authoritative workflow writer for each consequential state. UI
  cleanup alone is not evidence that a background action is wired or safe.
- Do not hand-edit `supabase/schema.sql` or Atlas. Apply schema changes through
  the governed migration path, regenerate the live snapshot, and refresh Atlas
  after real code/schema changes.
- Preserve historical and approved records. Any convergence or retirement
  requires source mapping, a migration plan, backups/rollback strategy, audit
  evidence, and authorization tests.
- Bob may research, summarize, classify, and prepare proposals. Bob and
  background workers do not bypass the same human gates or authorization
  boundaries as the rest of the product.

## Acceptance evidence required before release

1. A user can complete representative client/place setup, workforce, and
   finance tasks through the three areas without re-entering the same
   authoritative facts or losing selected context.
2. A completed shift can be traced through staff, client, place, applicable
   service relationship, payable hours, wage, loaded labour cost, quote or
   charge, and invoice state without conflating those records or measures.
3. Routine automation only acts under an approved, scoped, effective rule;
   retries do not duplicate work; a human can review, edit, cancel, or approve
   within their authority.
4. Ambiguous source data, missing authority, permission failure, stale input,
   and background-job failure become visible exceptions with an owner and safe
   next action—not guessed data or success-shaped fallback.
5. Client, staff, provider, and finance data remain correctly scoped across
   roles. Unauthorized users cannot infer or read another party's private
   records.
6. Desktop and mobile walkthroughs cover loading, empty, partial, error,
   permission, blocked, success, stale, and recovery states, with persisted
   results checked through the governed writer.
7. VB-15 is accepted only when its timesheet actions call real authorized
   workflows, persist the intended result, surface explicit failures, and
   pass focused tests plus a human walkthrough. Placeholder notices are not
   acceptance.

## Left to the implementation planner

After this design is approved, the implementation plan must:

1. Refresh Atlas and inspect the live schema, migrations, permissions, routes,
   and source writers for the client/place, workforce, timesheet, payroll,
   quoting, invoicing, and background-job paths.
2. Produce an entity and ownership crosswalk showing canonical records,
   duplicate/legacy representations, real readers and writers, access rules,
   and what may safely be consolidated.
3. Define the first bounded vertical slice. The recommendation is to complete
   the existing VB-15 timesheet workflow first, but only after its no-op
   actions and fit with this design are resolved.
4. Select the smallest safe migration sequence, compatibility period, rollback
   conditions, and acceptance tests. Do not rewrite `FOUNDATION.md` or
   authoritative canon by assertion; record approved changes and dated
   rationale in the owning documents.
5. Inventory routine actions suitable for pre-approved background execution
   and define human gates for all exceptions and high-impact outcomes.

The earlier `2026-11-15-automatic-timesheets-and-cost-allocation-design.md`
is a narrower working draft, not an approved product direction. This document
is the approved umbrella design. The first implementation plan is limited to
the Workforce/timesheet vertical slice; Client Data & Setup and Finance remain
separate later plans.
