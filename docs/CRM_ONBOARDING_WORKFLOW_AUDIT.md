# CRM Onboarding Workflow Audit

Verified 2026-08-30 against the active AdminShell routes, current React pages,
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

## Gaps Confirmed

1. No human, resumable onboarding record exists.
2. Organization duplicate prevention is strong only when NZBN is known. Name
   search is not a uniqueness guarantee.
3. Site `address_match_key` is indexed but not unique, so candidate review must
   precede creation and ambiguous matches must remain visible.
4. Existing agreement readiness does not require an active primary contact,
   accepted agreement, enabled module, authoritative/provisionally acknowledged
   boundary, operational work unit, or explicit activation decision.
5. Organization and service-agreement tables still expose broad direct mutation
   grants and overlapping policies. A human onboarding UI must not write them
   directly.
6. There is no single operational handoff view joining what was sold, covered
   places, contacts, modules, hazards, commercial readiness, and first actions.

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

1. `find_crm_onboarding_candidates` for scoped organization/NZBN and site/address
   candidate search.
2. `start_crm_onboarding` for retry-safe draft creation or attachment to an
   existing account.
3. Governed organization, site, agreement, location-link, and module transitions.
4. `get_crm_onboarding_readiness` composed from canonical tables and the existing
   agreement readiness evidence.
5. `activate_crm_account` with row locking, expected draft state, blocker checks,
   and audit provenance.

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

1. Draft ledger, scoped candidate search, and readiness RPC.
2. Qualify lane using the existing governed account workspace for contacts.
3. Governed site creation and boundary-review handoff.
4. Governed agreement/location/module setup.
5. Operational and commercial readiness integrations.
6. Activation gate, handoff summary, incomplete queue, and time-to-live metrics.
