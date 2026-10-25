> **Canonical copy.** Origin: GitLab `don-squires1/field-compliance-manager` `` @ `Main`, read 2026-09-14 via `scripts/gitlab-read.mjs`. This repository (`DonSquires/Field-Compliance-Manager-` `main`) is the authoritative home from now on; the GitLab text is lineage. Edit here and record the ruling — never fork the text. Links to files that do not exist in this repo refer to that lineage.

# Organisation and Service Model — Model A (Own-Rooted)

> **Ratified 2026-07-21.** This document describes Model A: every org is
> own-rooted, role is contextual per service_agreement. The machine-readable
> summary Bob uses is `knowledge_base/corpus/org-model.md`.
>
> **Supersedes** the old tree-parented client model (clients hanging under
> branches via `parent_organization_id`). See
> `docs/design/ONBOARDING_AND_ENTITLEMENT_EXPERIENCE.md` for the full design.
> Migration 0271 implements the access-layer fix. Issue #214, Epic #213.

## Model A: every org is its own entity

Every organisation is **own-rooted** (`parent_organization_id = NULL`). Role
(client vs provider) is **contextual per `service_agreement`**, not baked into
`organization_type`. The only link between Iron Eagle and another org is the
financial (Layer-1) service agreement.

```
Iron Eagle Security (owner, own-rooted)
Acme Council (government, own-rooted)
  └─ linked by service_agreement (Iron Eagle = provider, Acme = client)
Beta Security Ltd (service_provider, own-rooted)
  └─ linked by service_agreement (Iron Eagle = provider, Beta = client)
  └─ linked by service_agreement (Beta = provider, Acme = client)
```

`organization_type` values: owner, service_provider, branch, client, contractor,
government, private_enterprise. These describe what the org IS, not its role in
any specific relationship.

> **Legacy table naming (read this before touching sites/zones).** The Site
> table is **`client_sites`** and the Zone table is **`location_zones`** - these
> names are LEGACY. `client_sites` is NOT "client-owned sites"; it is the **Site
> facet** of a Location ("house"), and `location_zones` is the **Zone facet** -
> siblings under a `locations` row, linked by `location_id` (House model,
> migration 0145). Read `client_sites` as "sites" and `client_sites.client_organization_id`
> as the place's OWNER org. The tables were repurposed, not renamed, to avoid a
> wide rename across RPCs/RLS/edge-functions/frontend/Bob-knowledge. See
> migration 0312, `house_location_model` Bob card, and `docs/LOCATION_HIERARCHY.md`.

## How organisations link: service_agreements

The `service_agreements` table is the canonical inter-org link:

| Column | Meaning |
|---|---|
| `provider_organization_id` | The org providing the service |
| `client_organization_id` | The org receiving the service |
| `ends_on` | NULL = perpetual; `>= current_date` = active |
| `enabled_modules` | Which modules the agreement covers |

An org can be a provider in one agreement and a client in another.

## Legacy tree model (still supported)

The `parent_organization_id` tree still works for orgs created under the old
model (branches under a service provider, clients under a branch). The access
layer supports **both** paths — tree-based and agreement-based (migration 0271).
New orgs are own-rooted.

## Access layer

### Visibility: `org_access_allowed(target_org_id)`

Gates SELECT on ~60 tables. Passes if ANY of these is true:

1. **grand_master** — unrestricted.
2. **Direct membership** — user's `organization_id` = target.
3. **Authorized branches** — target in `authorized_organization_ids`.
4. **Tree descent** — master/admin: target in descendant tree of their org.
5. **Access grants** — `provider_client_access_grants` row exists.
6. **Agreement-based (0271)** — user's org (or employer org) is a party on
   an active `service_agreement` with the target org. **Bidirectional.**

### Write gates

- **`is_master_for_org(p_org_id)`** — master can manage orgs in their
  descendant tree **OR** orgs that are the client on an active agreement
  where the master's org is the provider (0271, provider-side only).
- **`is_admin_for_org(target_org_id)`** — same pattern for admin role,
  plus grand_master unrestricted.

### Organisation INSERT

- **grand_master** can create any org (including own-rooted, parent = NULL)
  via `gm_full_access` (0076).
- **master** can create sub-orgs (client/branch/contractor) under their
  tree via `master_manage_orgs_insert` (0093). Cannot create own-rooted orgs.

## How a user links (three columns)

| Column | Meaning |
|---|---|
| `employer_organization_id` | Corporate employer (HR/payroll). |
| `staff_branch_authorisations` (+ mirrored `authorized_organization_ids`) | Branch(es) the user operates at = **workspace**. |
| `organization_id` | Operational home. For own-rooted org users: their org. For branch users: their branch. |

## Login rule

- **Own-rooted org user** (no branch authorisations): lands at their own org
  directly (`single_branch` mode, org = workspace).
- **Branch user**: lands at their branch (single → straight in; multiple →
  branch picker).
- **grand_master**: whole-tree view, optional branch filter.

## Onboarding (Model A)

Iron Eagle (grand_master) creates each org as own-rooted, provisions a first
user as `master`, and creates a Layer-1 service agreement. The org's master
then manages their own data.

## Two-layer billing (issue #2, migration 0253)

- **Layer 1** = Iron Eagle → org (platform subscription): `module_catalog`,
  `org_module_subscriptions`.
- **Layer 2** = provider → client (on-charge): `crm_commercial_settings`,
  `rate_rules`, `invoice_line_items`.

## Standing rule

Every create-user / create-org / onboarding path MUST set the three user org
columns correctly. For own-rooted org users: `organization_id` =
`employer_organization_id` = their org. For branch users: follow the branch
convention.

## Platform-owner boundary (owner ruling, Don Squires, 2026-09-15)

Iron Eagle Security is the **platform owner**, not a co-operator of its
subscribers. Every provider (R & M Security and Investigation is the first)
**subscribes** to the app. The relationship is the same shape as any
multi-tenant SaaS (GitHub-style):

- **Iron Eagle may:** create the subscriber as an own-rooted
  `service_provider` org; hold the Layer-1 `service_agreements` row
  (`agreement_type = 'financial'`, Iron Eagle = provider) and the
  `org_module_subscriptions` it sells; receive the subscription money; suspend,
  reinstate or cancel the subscription; invite the subscriber's first/next
  `master` user; re-send invitations; run account recovery for a locked-out
  org; and monitor **activity health as aggregates** (last sign-in, active
  user counts, module usage counts, storage) for billing and support.
- **Iron Eagle may not:** read or write the subscriber's operational or
  financial records (shifts, jobs, evidence, sites, contacts, rate rules,
  quotes, invoices, payments, P&L, HR). A Layer-1 **financial** agreement is a
  billing link only; it grants **no** data visibility in either direction.
  Only an **operational** agreement (provider delivers services to a client)
  carries the agreement-based visibility of migration 0271.
- **The subscriber's `master`** owns the org's data, users, modules-in-use,
  rate book, finance and audit, and may in turn act as a provider to its own
  clients under Layer-2 operational agreements.

Consequences the build must honour (code that disagrees is wrong until it is
changed):

1. `org_access_allowed` clause 5 (agreement-based visibility) is restricted to
   `service_agreements.agreement_type = 'operational'`. The Layer-1 financial
   agreement stops conferring reads.
2. `is_master_for_org` / `is_admin_for_org` provider-side authority over an
   agreement client applies to **operational** agreements only.
3. `grand_master` unrestricted reach (clause 1 and `gm_full_access`) is
   narrowed to the **platform-control surface**: `organizations`,
   `service_agreements` (financial), `module_catalog`,
   `org_module_subscriptions`, identity administration on `user_profiles`
   (invite / recover / deactivate — never impersonate), audit of those actions,
   and aggregate activity metrics. Emergency access to a subscriber's records
   goes through the ACCESS_MODEL §10 break-glass path, logged and time-boxed —
   never through standing role reach.
4. A governed, grand_master-only provisioning RPC replaces direct
   `organizations` inserts for subscribers: create (or reclassify a
   dependent-free CRM prospect row into) an own-rooted `service_provider`,
   create the Layer-1 financial agreement, seed `org_module_subscriptions` for
   the purchased modules, and hand off to `invite-org` for the first `master`.
   The CRM `manage_crm_organization` path remains for a provider's **clients**
   and must not be used to create subscribers.
5. Password reset stays self-serve for users; the owner's tools are
   `invite-org` (invite / recovery) and `resend-invite`. An owner-triggered
   recovery for an org that still has active users is a separate, audited
   action, not a shared password or session.

Live status at ruling time (project `dotczcyyzgabmtmnglqj`, read 2026-09-15):
R & M exists as a `private_enterprise` CRM prospect parented to Iron Eagle
(inactive, no users, agreements, subscriptions, modules or sites) and must be
reclassified under item 4; items 1–3 are not yet implemented — the financial
agreement currently confers bidirectional visibility.

### Who holds `grand_master` (owner ruling, Don Squires, 2026-09-15)

Exactly two identities hold `grand_master`, both in Iron Eagle Security: the
owner (Don Squires) and Bob's canonical system identity
(`00000000-0000-0000-0000-00000000b0b0`, the one every `bob_full_read` policy
names). **No other organisation may hold a `grand_master` account** — a
subscriber's top role is `master`. Any further `grand_master` row is a defect
to be downgraded or deactivated, never a second owner.

Live at ruling time: four `grand_master` profiles existed — the two above plus
two unreferenced duplicate "Bob" identities created 2026-08-21, one of them
inside First Security Guard Services LTD. Neither duplicate is named by any
policy, function or configuration.

### Bob reads fleet-wide; Conductor and Oracle govern what leaves (ruling, 2026-09-15)

Bob's data reach is **not** narrowed by the platform-owner boundary above. Bob
reads across every organisation regardless of who is talking to him; the
**Conductor** (egress gate, `redactOutgoing`) and the **Oracle** (truth-state
of caller, scope and proof grade) decide what may be passed to the caller, in
line with the Privacy Act 2020 (IPP 10/11 — use and disclosure limited to the
purpose of collection, and to the caller's authority). This is the existing
`BOB_DOCTRINE.md` §3 rule ("Bob thinks fleet-wide, speaks within rank") made
explicit against the subscriber boundary: item 3 above narrows **human**
`grand_master` reach; it does not narrow Bob.

### The one cross-tenant exception: health-and-safety flags (ruling, 2026-09-15)

When any organisation raises a health-and-safety flag on a **person, vehicle
or place** (`entity_flags`, entity types `person` / `staff` / `vehicle` /
`place`), the **existence and nature of the risk is visible platform-wide** to
any officer or organisation about to deal with that entity, with identifying
and substantive detail **redacted**: what is surfaced is the entity as it is
already known to the viewer (the plate, the place, the person they are
standing in front of), the hazard class, the severity, and the raising
organisation's contact path for a lawful request — never the other org's
narrative, evidence, complainant, or personal details. Basis: HSWA 2015 duties
(s.36 primary duty of care, s.34 duty to consult/co-operate/co-ordinate with
other PCBUs sharing a workplace or risk) read together with the Privacy Act
2020 (IPP 11(1)(f) — disclosure necessary to prevent or lessen a serious
threat to health or safety). This is `BOB_DOCTRINE.md` Tier 3 ("surface the
warning, strip identity") applied to humans as well as to Bob. All other
of-interest flags (VOI/POI/LOI/trespass/welfare) stay org-scoped.



## Ruling 2026-09-21 — configuring before acceptance

The provider records what it has been contracted to do on its own live
operational agreement (`invitation_status` in `not_invited`, `invited`,
`accepted`): covered places, modules, delivery schedules, patrol runs. The
client's acceptance of the invitation grants **portal access**; it is not the
provider's permission to configure. A client can be invited once it has at
least one place (a site address or an area) — a zone is not specifically
required. Delivery schedules may be written directly
(`manage_crm_agreement_delivery_schedule`) as well as through quote acceptance;
both link the patrol config by `client_site_patrol_config.delivery_schedule_id`.

## Ruling 2026-10-25 — Mainland Pest Control under R&M; group charge catalog

Owner choice `mainland_parent=true`: Mainland Pest Control, an R&M
subsidiary, has `parent_organization_id` = R&M (migration
`20261024235708_rm_group_charge_scope.sql`). This uses the legacy tree path
that R&M already uses for its client organisations. R&M masters and admins
reach Mainland by tree descent. Mainland's users gain no upward access to R&M,
and Mainland's own clients stay own-rooted. Other new organisations remain
own-rooted under Model A.

Owner choice `scope=rm_group`: the R&M group charge-code catalog (OneFortyOne
numbering) is owned by R&M and copied to R&M's tree (including Mainland) and
to the client side of every active operational agreement whose provider is in
that tree. New children and new agreements receive it by trigger. Ending an
agreement removes nothing. It is not a platform-wide template.

## Ruling 2026-10-25 — Extra work outside the contract: Extra works orders, not variations

A provider's operational agreement sets the contracted scope and, where agreed,
a fixed monthly price. Work the client asks for outside that scope is **Extra**
and is charged on top. It does not change the agreement.

- **One-off Extra (dispatch).** A dispatcher classifies each dispatch job as
  `contract` or `extra` (`dispatch_jobs.billing_basis`, NULL = not yet
  classified) through `set_dispatch_job_billing_basis`. The console has no
  default: the dispatcher must choose Contracted, Extra or Decide later,
  because regular security work (patrols, gate open/close, lock checks and
  replacement) is Contract and must not be swept into Extra. Changing an existing
  classification needs a reason; every change is audited; an invoiced job is
  corrected by credit note, not reclassified. Charge lines inherit the job's
  basis.
- **Temporary or ongoing Extra (agreement level).** An **Extra works order**
  (`agreement_extra_work_orders`, managed only through
  `manage_agreement_extra_work_order`) records what the client asked for, how
  it was authorised (written, purchase order, verbal with a note, standing
  instruction), its term, and an optional review date and default charge code.
  It hangs off the base agreement, so jobs stay on the agreement that owns the
  place. An Extra job may be linked to an order in force on the job's day.
- **Not a variation.** An Extra works order never changes covered places,
  modules, obligations or price. When Extra work becomes a permanent part of
  the service, vary the agreement and end the order.
- **OneFortyOne codes.** Lock replacement (42063) and gate open/closed remain
  Contract: they are part of the regular security role. The OFO schedule's
  Extra codes (for example Friday 41358/42061 and Monday 41320/42034 for
  hunter access) stay Extra.
- **Derived codes default to Extra (owner ruling 2026-10-25).** Charge codes
  derived from the group catalog (`origin = derived`) carry
  `billing_basis = Extra`, `basis_source = owner_default_2026-10-25`. A code
  can be moved to Contract individually; OneFortyOne-origin codes keep the
  client's own schedule.
- **Invoicing respects the basis.** `generate_crm_invoice_from_completed_work`
  bills only Extra callouts (labelled with their Extra works order reference),
  never Contract callouts (covered by the agreement price), and refuses to run
  while any callout in scope has no billing decision.
- **Imported patrol rows are classified at read time.** The workbook's own
  TYPE column wins; otherwise the charge code's catalog basis; otherwise
  "not classified". Disagreements are counted, not hidden. The rule lives in
  one place (`classify_patrol_cost_row_billing_basis`) so every view agrees.
  `get_agreement_billing_basis_summary` reports this per month with callouts,
  Extra works orders and the recorded contract price. These amounts are
  service cost, not revenue, and imports still do not write finance directly.
- **The finance period shows the split; cost lines are never split.**
  Reconciled `finance_service_costs` lines stay one per agreement, month and
  component. `get_finance_pl_period_billing_basis` derives Contract, Extra,
  not classified and other from the linked source rows and the dispatch job's
  billing choice, and its total must equal the P&L period's recorded cost.
- **Open.** ~~The fixed monthly price is recorded as an accepted quote (none
  recorded for OneFortyOne yet).~~ Recorded 2026-10-26 (see the next ruling).

## Ruling 2026-10-26 — each client is billed on its own commercial model

Not every client receives the OneFortyOne arrangement. How a client is billed
is a property of its **service agreement**, held in
`crm_commercial_settings.commercial_model` (one row per agreement) and set only
through `set_agreement_commercial_terms` (provider administrator, audited,
reason required to change an existing model). The four models:

| Model | Meaning | Dispatch | Invoicing |
|---|---|---|---|
| `fixed_price_with_extras` | A fixed contract price covers the agreed service; anything outside is Extra. | Each callout is Contracted work or Extra (rules above). | Only Extra callouts are billed; Contract is covered by the price; unclassified callouts block invoicing. |
| `pay_as_you_go` | All work charged at agreed rates each billing cycle. | No Contract/Extra decision; `set_dispatch_job_billing_basis` refuses. | Every completed callout is billed. |
| `do_and_invoice` | Standing authority: R&M does what is needed without asking first and invoices the actual time, travel and materials. **Not** the same as pay as you go (see the ruling below). | No Contract/Extra decision. A job over the agreement's standing authority limit needs the client's approval reference (same field and RPC as per request). | Every completed callout is invoiced at actuals (line text `Actuals — …`); a job over the limit with no approval reference blocks invoicing. |
| `per_request` | The client asks for each job. | The job carries the client's request or PO reference (`dispatch_jobs.client_order_reference`, via `set_dispatch_job_client_reference`, audited, reason to change, refused once invoiced). | Every completed callout is billed; a callout with no reference blocks invoicing and the reference is printed on the line. |

- **No model yet = Contract/Extra.** An agreement with no model behaves as fixed
  price plus Extra (`agreement_uses_contract_extra`), so nothing is billed by
  accident while terms are being set.
- **Terms live with the model.** Billing cycle, payment terms (0–120 days,
  used for the invoice due date when an agreement is invoiced), invoice email,
  standing PO, rates and notes are optional terms on the same row.
- **Finance shows the difference.** `get_finance_pl_period_billing_basis` moves
  all service cost on non-fixed agreements into a separate **billable, no
  Contract/Extra split** bucket, broken down as agreed rates (pay as you go),
  actuals (do and invoice) and per request, so Contract, Extra and not
  classified only ever describe fixed-price clients. Totals still reconcile to
  the period's recorded cost.
- **R&M seed (owner confirmed, 2026-10-26).** Fixed price + Extra: OneFortyOne,
  STAND, TDC, Birdhurst, Stringer, Wrattens, Thomas Bros, Taylors. Pay as you
  go: NCC, R&M Other Private, Private Parks, Private Redvale-Merc. Do and
  invoice: Tasman Pine Forests, Merril and Ring, NMDHB, NZ Health. Per request:
  DOC, Fulton Hogan (Maitai Dam), Operation Lizard (DART). Billing cycle and
  payment terms are seeded as defaults until confirmed per client.
- **OneFortyOne contract price.** Recorded as an accepted quote (13,333 per
  month, per the R&M finance workbook Sheet2), with its commercial snapshot.

## Ruling 2026-10-26 — do and invoice is standing authority, not pay as you go

The first build treated `do_and_invoice` exactly like `pay_as_you_go`. That was
wrong. Pay as you go bills each job at the agreed rates. Do and invoice means
the client has given R&M **standing authority** to do what is needed without
asking first; R&M then invoices the **actual** time, travel and materials.
The authority can be capped:

- **Standing authority limit.** `crm_commercial_settings.standing_authority_limit`
  (numeric, excl. GST, per job; NULL = no cap). A CHECK allows a value only on
  `do_and_invoice` agreements. It is written only through
  `set_agreement_commercial_terms` (audited); switching an agreement to another
  model clears it.
- **Over the limit needs approval.** A job whose charge lines (all of them,
  invoiced or not) total more than the limit needs the client's approval
  reference, recorded through `set_dispatch_job_client_reference` (audited).
  Until then `generate_crm_invoice_from_completed_work` refuses to invoice the
  client, and the agreement summary counts the job in
  `jobs_over_standing_authority_without_approval`.
- **Invoices say actuals.** Do-and-invoice lines are prefixed `Actuals — `
  (plus `Client approval REF — ` when a reference exists).
- **No limit is set for any client yet.** The R&M finance documents define no
  standing authority amount, so the seeded agreements (Tasman Pine Forests,
  Merril and Ring, NMDHB, NZ Health) have no cap until the owner sets one.

Migration `20261026100000_do_and_invoice_standing_authority.sql` also fixed a
defect found while previewing this: the unique index
`idx_invoice_line_items_source_dispatch` allowed only one invoice line per
dispatch job, but completion writes Attendance and Travel as separate charge
lines, so any job with travel could not be invoiced. The index is now
non-unique, and the invoice loop locks the charge lines it stamps.

## Ruling 2026-10-25 — invoiced monthly, due on the 20th; all prices before GST

Owner ruling (Don Squires): every R&M client is invoiced monthly. A month's work
is invoiced in the first week of the next month and is **due on the 20th of
that month** (October work, invoiced early November, due 20 November). All
agreed rates, prices and limits are **before GST**; GST (15%) is added when the
invoice is created. No standing authority limit applies unless one is entered.

- **Due day of the following month.** `crm_commercial_settings.payment_due_day_of_month`
  (1–28; NULL = use `payment_terms_days` after the invoice date). Set only
  through `set_agreement_commercial_terms` (audited).
- **One rule for both invoices.** `invoice_due_date(invoice_date, period_end,
  terms_days, due_day)` gives the due day of the month after the invoiced
  period, rolled to the next month when the invoice is raised after that day.
  `generate_crm_invoice_from_completed_work` and
  `generate_crm_invoice_from_agreement` both use it. Before this,
  the agreement-price invoice always set the due date 14 days out and ignored
  the agreement terms.
- **R&M set.** Migration `20261027090000_invoice_due_twentieth.sql` set all 19
  R&M agreements to monthly billing, due on the 20th (audited as
  `agreement_commercial_terms_set`). New billing terms start on the 20th in the
  form; saved day-count terms are kept until changed.

## Ruling 2026-10-26 — client rates, and the monthly fee is drawn down to $0

Owner ruling (Don Squires): each client's rates are in the invoice
spreadsheets. When a client has no rate of its own, the **standing rate card**
applies; that is what the rate bureau is for. On a fixed monthly fee, each
contracted job or action charged to the client **draws down the fee**, so a
fully delivered month nets to **$0**.

- **If the month nets above $0**, contracted value was not delivered. R&M
  credits it.
- **If the month goes below $0**, the work above the fee is **Extra**. It must
  be justified, unless the agreement already says it is billed. OneFortyOne's
  does.

How the build holds this:

- **Rates.** `resolve_rate_rule` prefers a rule for the client over a rule with
  no client, so rules with no client are the standing rate card. Client rates
  taken from R&M's invoice workbooks are loaded as client-scoped `rate_rules`
  (migration `20261029090000_client_rates_from_invoice_workbooks.sql`, each
  rule audited with its workbook as provenance, all excl. GST):
  - an hourly rule carries the client **and** a service type (patrol, security
    enquiry, investigation, cordon guard, camera review). A client-only hourly
    rule would outrank the standing specialist rules (engineering, excavator,
    two-person), so specialist work stays on the standing card;
  - a per-km rule is client-wide, because dispatch resolves travel without a
    service type;
  - a client with no workbook rate stays on the standing card;
  - rates price new work and quotes; existing charge lines and imported rows
    are not repriced.
- **Fee and work.** `get_agreement_fee_drawdown` reports each month's fee: the
  accepted quote lines, or the commercial base rate. It reports contracted work
  from three sources:
  - imported patrol log rows classified Contract;
  - Dispatch charge lines on the contract basis;
  - patrol visit charge lines.
- **Blockers.** The report lists what stops a month being settled:
  - the month has not finished;
  - unclassified log rows;
  - undecided or unpriced callouts;
  - unresolved patrol visits;
  - no fee;
  - no work.
- **Settlement.** It applies only to `fixed_price_with_extras`.
  `generate_crm_invoice_from_agreement` settles one whole calendar month once,
  recorded in `agreement_fee_settlements`:
  - a credit line for unused value;
  - an Extra line for work above the fee, when billed;
  - nothing, when absorbed.
- **Who decides on work above the fee.**
  `crm_commercial_settings.fee_overrun_policy` sets this per agreement:
  - `bill_as_extra`: already agreed with the client;
  - `justify` (the default): the invoicer bills it with a 10–500 character
    reason, or absorbs it.
- **Redoing a month.** Voiding the invoice frees the month to be settled again.
- **No double billing.** The completed-work invoice no longer bills patrol
  visits on these agreements, because they are drawn down against the fee.
- **OneFortyOne.** Set to `bill_as_extra` in migration
  `20261028090000_monthly_fee_drawdown.sql`, audited. The other fixed-price
  clients have no fee recorded, so they show "no monthly fee" until one is
  added.