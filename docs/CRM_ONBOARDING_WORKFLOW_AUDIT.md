# CRM Onboarding Workflow Audit

Verified 2026-08-31 against the active AdminShell routes, current React pages,
`supabase/schema.sql`, and live Atlas. Bob's legacy-oriented recommendation is
used here as a workflow hypothesis, not as evidence about the current UI.

## Current Truth

- `CRMPage` is active CRM and finance operations. It manages account contacts,
  relationship activity, quotes, and existing invoice lifecycle through governed
  RPCs.
- `RelationshipWorkspacePage` is active agreement context. Provider users can
  open the same account workspace used by CRM.
- `OrganizationSetupPage` configures the signed-in provider organization,
  organization modules, notice templates, and geofence defaults. It is not a
  client onboarding page and must remain separate.
- `v_service_agreement_readiness` is useful existing evidence, but it only checks
  sites, agreement-location links, and financial configuration for organizations
  that already have agreements. It is not a complete onboarding state model.
- `bob-propose-client-onboarding` creates pending Bob proposal records. It is an
  optional governed producer, not the human onboarding workflow or canonical
  readiness owner.
- The active CRM organization spine now searches scoped name/NZBN candidates
  before creation, creates retry-safe inactive prospects, race-checks edits,
  and shows the next readiness action from canonical contact, site, agreement,
  module, commercial, and work-unit evidence.
- Provider profile changes in Organization Setup and account organization changes
  are both RPC-owned and audited. Direct authenticated organization mutation is
  revoked.
- CRM site creation is candidate-first, retry-safe, and audited. New sites begin
  with explicit provisional, unverified boundary provenance.
- The Sites route is an operational boundary-review queue. It can establish
  provisional point-radius evidence but does not claim visual polygon verification.
- Accepted operational agreements now expose governed covered-site and module
  setup. Direct authenticated writes to agreement locations and modules are revoked.
- Agreement readiness now evaluates canonical coverage, authoritative boundary,
  module, positive billing-rate, attributed work-unit, and reporting-template
  evidence. Every blocker links to its existing owning workspace.
- Account Onboarding is now a durable target-live queue backed by a tenant-scoped
  stage ledger. Review entry and activation are expected-state, blocker-checked,
  row-locked, and audited server transitions.

## Gaps Confirmed

1. The durable ledger covers qualification, configuration, review, and activation.
  Detailed per-stage notes and assignment history are not yet modeled.
2. Candidate search and in-hierarchy exact-name rejection are live. Name search
  remains candidate evidence rather than a global uniqueness guarantee.
3. Site `address_match_key` is indexed but not globally unique. The governed
  account-scoped candidate and creation flow serializes duplicate review.
4. The lightweight account summary readiness does not include boundary or
  reporting evidence. Account Onboarding uses the detailed operational evaluator
  as the canonical activation gate.
5. The agreement header remains quote-lifecycle owned. Covered-site and module
  rows are RPC-owned, but remaining agreement profile fields still need a
  deliberately scoped owner before additional UI controls are exposed.
6. Activation records the canonical account and agreement transition, but a
  post-activation handoff view joining hazards and first actions is still absent.

## Target Workflow

The target is a separate **Account Onboarding** workspace, not a long modal and
not an extension of provider Organization Setup.

### Qualify

- Search organization name and NZBN before create.
- Show likely candidates with ownership and relationship context.
- Create or select one account.
- Add a primary contact through `manage_crm_contact`.
- Save as a resumable prospect; no operational access is implied.

### Configure

- Select or create covered sites through a governed site owner.
- Show address-match candidates before creation.
- Keep boundary provenance visible: authoritative or provisional.
- Create the service agreement and explicitly select covered locations, modules,
  start date, reporting cadence, and billing owner.
- Configure operational work units, hazards/instructions, routes, or checkpoints
  only when required by selected modules.

### Review And Activate

- Present evidence-backed readiness dimensions rather than a percentage:
  `identity`, `contact`, `agreement`, `location`, `boundary`, `modules`,
  `operations`, `billing`, and `reporting`.
- Every blocked dimension must include a human explanation and owning role.
- Activation must be an expected-state, audited RPC transition.
- Activation is refused while mandatory dimensions are blocked.
- Provisional boundaries may be allowed only through an explicit, audited
  exception rule; they are never silently treated as authoritative.

## Roles

Current schema roles should be used until dedicated CRM roles exist:

- **Admin/master:** qualify accounts, manage contacts, and prepare agreements.
- **Operations admin:** locations, boundaries, hazards, routes, and work units.
- **Finance admin:** commercial settings and billing readiness.
- **Approver:** final readiness review and activation.

The UI may describe responsibilities in human terms, but it must not claim a
sales/finance role boundary that the authorization schema cannot enforce.

## Server Ownership Required

Implement these boundaries before exposing their corresponding UI actions:

1. **Complete:** governed site/address candidate search and retry-safe creation.
2. **Complete:** resumable, versioned stage ledger attached to prospects.
3. **Complete:** quote-owned agreement creation plus governed site boundary,
  location-link, and module transitions.
4. **Complete for accepted agreements:** operational readiness includes boundary,
  commercial, work-unit, reporting, owner, and destination evidence. The account
  summary RPC still remains a lighter qualification view.
5. **Complete:** `activate_crm_account` uses row locking, expected prospect and
  ledger state, operational blocker checks, and audit provenance.

## Acceptance Criteria

- A new administrator can qualify an account without knowing table names.
- Search is always shown before organization or site creation.
- Draft progress survives navigation and another authorized administrator can
  resume it.
- CRM, Relationships, Sites, roster/work units, dispatch, billing, and reporting
  consume the same organization/agreement/location records.
- No UI readiness claim is based on FK adjacency or a default-valued column.
- Every blocker states what is missing, who owns it, and the command that resolves
  it.
- The activation RPC rejects incomplete, stale, unauthorized, or duplicate
  transitions.
- Desktop and mobile Playwright scenarios cover create, resume, blocked review,
  completion, activation, stale-state rejection, and retry behavior.

## Delivery Order

1. **Complete:** scoped candidate search, readiness RPC, and durable stage ledger are live.
2. **Complete:** qualify lane uses the governed account workspace for contacts.
3. **Complete:** governed site creation and boundary-review handoff.
4. **Complete:** governed agreement/location/module setup.
5. **Complete:** operational and commercial readiness integrations with owner handoffs.
6. **Partial:** activation gate, incomplete queue, target-live ordering, and age
  metrics are live. Post-activation handoff summary remains.
