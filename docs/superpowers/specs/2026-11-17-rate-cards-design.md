# Rate cards: versioned client charge and staff pay cards

Date: 2026-11-17 · Owner: DonSquires · Status: approved 2026-11-17

## Why

"Pay and charge rules" is where the owner sets staff pay rates and client charge
rates. Today it is one long list of 78 loose rules under a stack of payroll,
discount and fuel panels. To find "what do we charge OneFortyOne?" you have to
scroll and read rule names. Rates have no shared version. You can't say "these
are OneFortyOne's 2027 prices from 1 April", review them, approve them, and keep
the 2026 prices for work already done. The owner wants this built the way an
enterprise app would build it (owner ruling, 2026-11-17: option B).

The rate card becomes the place the app takes its prices from. Labour, response,
travel and equipment all come from cards. Materials and equipment stay in the
price book.

## Goals

- A **rate card** is a named, owned set of rates. There is one **Standard** card
  per operating branch, and client cards for clients who have their own pricing.
  Staff pay uses **pay cards**.
- Every price change is a **draft version** with an effective date. It takes
  effect only after someone with finance access approves it. Approved versions
  are never edited.
- An agreement points at a client card. A place can still override a single rate
  (existing place selections). When a rate is missing, the resolver uses this
  order: the place override, then the agreement's card, then the Standard card.
- Every existing price reference keeps working. That covers the charge lines, pay
  lines, quote modules, delivery schedules, labour postings and place selections
  that store a `rate_rule_id`. Work that is already priced or invoiced does not
  move.
- Rates on a card are grouped so people can scan them: Labour, Response,
  Travel, Equipment & hire, and Other.
- Equipment rates (for example a digger at $/hour, plus $/km while towed) can be
  linked to the equipment record. When that record has an approved cost profile,
  the card shows cost and margin, the same way the price book does for materials.

## Non-goals

- Materials and consumables stay in the price book (Prices & discounts).
- No change to how rates are matched within a card. The specificity order is
  site > zone > client > service > job/module > role/day > distance.
- No automatic price increases (for example CPI). The owner creates and approves
  each new version.
- Discount plans stay where they are.
- Travel/KM/onsite leg charging and casual work are separate items in the queue.
  They will use cards, but they are designed separately.

## Anti-goals (failure even if it "works")

- Any invoiced or priced line changes amount or loses its rule reference.
- A rate takes effect without approval, or an approved version is edited in place.
- A client with no card gets charged $0. The Standard card or the "Needs a rate"
  queue must catch it. Never write $0.
- Two copies of the same price. For example, a client's hourly rate held both in
  the agreement's commercial settings and on its card, and the two disagree.

## Approaches considered

- **A. Reorganise the page only.** Group the existing rules by client in the UI.
  This is cheap, but it adds no versioning, approval or ownership, so it isn't
  how an enterprise app would build it. Rejected by the owner.
- **B. Real rate cards with versions. (Chosen.)** Add card and card-version
  records. Rules become lines on a version, and the single resolver
  (`resolve_rate_rule`) learns about cards. This is lower risk than it sounds,
  because every price lookup already goes through that one function and existing
  `rate_rule_id` references stay valid.
- **C. One list collapsed by client.** The least work, but the page stays
  cluttered and there is still no versioning. Rejected.

## Owner decisions

- Option B, built to enterprise standard (2026-11-17).
- Price changes are versioned: draft → approve → effective from a date. The old
  version stays and keeps pricing work dated before the change (2026-11-17).
- Anyone with finance access may approve, which maps to the existing gate
  "authorised operating-branch finance administrator", i.e.
  `user_can_operate_organization` plus the finance-admin check already used by
  `manage_operating_branch_rate_rule` (2026-11-17).
- A digger and similar equipment are charged as operating hours plus towing km
  (2026-11-17). The owner left the rest of the design to the builder.
- **Every new or changed rate needs finance approval, wherever it is made**
  (2026-11-17). That includes the place Patrols & services dialogs ("create a
  charge rate"), staff-specific pay from HR (`manage_staff_pay_rate`), and Bob's
  `apply_bob_rate_rule_proposal`.
  - Each of these now saves a draft line on the correct card and raises a
    finance approval item.
  - The originating screen shows "pending approval" and no price applies until
    the line is approved.
  - A place selection that points at a pending line resolves as "pending". It
    never resolves to $0.
- **A client may have several cards; each agreement picks its card** (2026-11-17).
  A client has one default card, which is used when an agreement has no card set.
  The constraint becomes "at most one *default* active card per (branch, client)".

## Data model

Proposed tables (names are the builder's call):

- `rate_cards`
  - Columns: id, organization_id (operating branch), kind (`charge` | `pay`),
    name, client_organization_id (null for Standard and for pay cards),
    payroll_role_code (pay cards only, optional), is_standard, active, and audit
    columns.
  - One active Standard charge card per branch.
  - A client may have several cards. At most one active card per
    (branch, client) is marked `is_client_default`.
- `rate_card_versions`
  - Columns: id, rate_card_id, version_number, status
    (`draft` | `approved` | `superseded` | `retired`), effective_from,
    effective_to (set when a later version is approved), change_note,
    created_by, approved_by, approved_at.
  - Approved versions of one card never overlap in dates.
  - Only one draft per card at a time.
- `rate_rules.rate_line_key` (uuid, builder's call): a **lineage key** that
  follows the same rate across versions.
  - "Start a new version" copies each line into a new row with a new id, but the
    copy keeps the same `rate_line_key`.
  - Records that *choose* a rate point at it by lineage, so they follow approved
    price changes:
    - Place selections.
    - Delivery schedules.
    - Draft quote modules.
  - Records that *priced* work keep their exact `rate_rule_id` and never move:
    - Charge, pay and posting lines.
    - Accepted-quote snapshots.
  - Pointers held as `rate_rule_id` are resolved at use time: they find the
    approved line with the same `rate_line_key` that is effective on the work
    date. A new nullable `rate_line_key` column is added beside each pin, and
    the migration fills it.
  - If no approved line with that key covers the date, the result is
    "needs a rate", never $0.
- `rate_rules.rate_card_version_id`: a new nullable FK.
  - A rule belongs to exactly one version.
  - Rules on an approved version are immutable: a trigger rejects changes to any
    pricing column, and only `active` may change, through retirement.
  - The rule's own effective dates and active flag remain for compatibility, but
    the version's dates take over.
- `rate_rules.rate_group`: Labour, Response, Travel, Equipment & hire or Other.
  The migration derives it from service type, job type and rate type, and the
  editor lets you change it. It is display only.
- `rate_rules.asset_id`: optional, for equipment rates. This build only
  *shows* equipment rates and margin on cards (builder's call). Recording
  equipment hours and towing km on jobs belongs with the travel/KM/onsite card
  that comes next, which adds usage capture. Margin comes from the
  approved `finance_asset_cost_profiles` row: (acquisition + setup − residual)
  spread over productive hours or useful km.
- `service_agreements` gets `rate_card_id` (or a column on
  `crm_commercial_settings`, the builder's call). Null means Standard.

**Editing a card.** "Start a new version" copies every line from the current
approved version into a draft. You edit the draft, then submit it. Approval:

1. Sets effective_from.
2. Closes the previous version the day before.
3. Marks the previous version superseded.

All three happen in one transaction, with an audit row and an idempotent
`client_request_id`.

**Duplicate-price anti-goal.** `crm_commercial_settings.base_rate_per_hour`,
`callout_rate_per_hour` and `travel_rate_per_km` duplicate card prices. The
migration copies any non-null values onto that client's card as lines. After
that they are read-only and shown as "comes from rate card". The place dialogs'
"Agreement's standard rate" option becomes "Agreement's rate card". Callout
minimum and increment stay on the agreement, because they are terms, not prices.
The response-rate work in flight writes `callout_increment_minutes` there.
(Builder's call; it is also the smallest change to the response card.)

## Resolution

`resolve_rate_rule` keeps its specificity ordering. It gains an optional
`p_service_agreement_id` parameter: a new overload, with the old signature
delegating to it with NULL. It only considers rules on approved versions whose
date range covers the work date.

**A card replaces Standard rate by rate, not as a whole (builder's call).** The
client's card is searched first. Standard is searched only when the card has no
matching line for that request. This is what a rate card means: "our prices for
you, otherwise our standard prices".

It does mean that a Standard rule scoped to one site no longer beats a client's
general rule. Two things make that safe:

- The cut-over dry run re-resolves the last 90 days of priced lines and recent
  quotes under the new rules, and lists every case whose amount would differ.
- Before applying, each difference is either fixed in the migration, by moving
  that site rule onto the client card, or accepted by the owner.

The candidate set is picked in this order:

1. The agreement's card (`p_service_agreement_id`). If there is none, the
   client's default card for `p_client_org_id`.
2. The branch Standard card (the client columns on its rules stay null).
3. Pay: the staff member's rules (`staff_id`), then the payroll role's pay card,
   then the Standard pay card.

Callers that know the agreement pass it in: dispatch, patrol stops, quotes and
timesheets via shift → agreement. Callers that don't still get the client
default.

**Backdating (builder's call).** A version may start before the day it is
approved, but never on or before the start date of the version it replaces.
Approval never re-prices existing lines; priced work does not move. Unpriced
work dated in the backdated window picks up the new price the next time it is
priced or re-checked. The approval dialog lists how many unpriced items that
affects.

Legacy rules with no card version are matched as now until the migration
assigns them, so the resolver never returns nothing during cut-over.
`resolve_agreement_place_billing_rate` and the place selections keep working
unchanged; they still return the place override first.

## Migration of the 78 live rules (dry run first)

1. Create a Standard charge card and a Standard pay card per branch.
2. Create one client card per distinct `client_org_id`: NCC, OneFortyOne, DART,
   STAND, Barber, Coppins, Kaiteriteri, R&M Other Private, and NZ Health.
3. Give each card a single approved version 1, effective from the earliest
   `effective_from` of its rules. All of that client's active rules go on it
   (builder's call). Rules with later start dates keep their own
   `effective_from` and `effective_to` inside the version, and the resolver
   still checks both the version dates and the line dates. Nothing is copied, so
   every existing id stays exactly where it is. Each rule gets a fresh
   `rate_line_key`.
3a. Where an agreement's `crm_commercial_settings` rates differ from the
   client's existing rules, the migration creates a separate card for that
   agreement and points the agreement at it, instead of merging them.
4. Assign staff-specific pay rules (Dan, Pete, Don) to the Standard pay card, with
   their `staff_id` still set.
5. Leave inactive rules on a retired version.
6. Check duplicates: "Health NZ Mental Health Static Site Rate" ×2 and
   "NZ Health" ×2. The dry run lists them for an owner ruling. The migration
   merges nothing silently.

The dry run is a transaction that rolls back and prints: card → version → rules,
plus any rule it could not place. The owner checks the grouping before it is
applied.

## Page design (Finance → Pay & charge rules → renamed "Rate cards")

```
Rate cards   [Client charges] [Staff pay] [Payroll setup] [Needs a rate 4]
┌ Cards ─────────────┐ ┌ OneFortyOne · v1 approved · from 1 Apr 2025 ─────────┐
│ Search cards…      │ │ [Start new version]  [Compare versions]  History ▾   │
│ ★ Standard     14  │ │ Labour     Patrolling           $58.30 /h            │
│   NCC           6  │ │            Investigations       $58.30 /h            │
│ ▸ OneFortyOne   5  │ │ Travel     uses Standard $1.04 /km     [Override]    │
│   DART          6  │ │ Equipment  Excavator  $116.60 /h  cost $71 · 39%     │
│   Draft: STAND v2  │ │ Agreements using this card: Kaituna, Tasman forests  │
└────────────────────┘ └──────────────────────────────────────────────────────┘
```

- **Client charges.** The card list sits on the left, with search and a draft
  badge. The selected card sits on the right, grouped by rate group. Rates the
  card doesn't set show what they fall back to ("uses Standard …") and have an
  Override action. The card header shows its version, status, effective date
  and the agreements that use it.
- **Draft mode.** You can edit lines inline. There is a diff against the current
  version (old → new, % change). "Submit for approval" asks for an effective
  date and a change note. A finance user sees Approve or Reject. The submitter
  cannot approve their own draft unless they are the only finance user
  (builder's call; it is logged).
- **Staff pay.** The same layout, with one pay card per payroll role and
  staff-specific overrides listed under it.
- **Payroll setup.** Pay codes, payroll roles, late-arrival discount bands and
  fuel price input move here, off the main view.
- **Needs a rate.** Finished jobs and patrol visits that have no rate. Each one
  links straight to the card and group where the missing rate belongs, with
  the scope filled in.
- **States.** Every view has loading, empty ("No client cards yet: start from
  Standard"), error, permission (read-only for non-finance users) and success
  states. It is responsive: below tablet width the card list collapses to a
  picker, and grouped rows replace the wide table, so there is no horizontal
  scroll.

## What uses cards (blast radius)

These read prices through `resolve_rate_rule` or `rate_rules` and are
re-tested:

- Dispatch financials (charge and pay lines).
- Patrol stop charge lines.
- Timesheet effective pay.
- Labour cost postings.
- Quote proposal modules and scope schedules.
- The accepted-quote commercial snapshot.
- Roster commercial readiness, payroll setup readiness and cost of service.
- Bob's rate-rule proposal.
- `PriceListPicker`, which should list rates from the client's card first.
- Place selections and the response card.

## Left to the builder

Exact names, file split, the trigger versus RPC guard for immutability, the
rate-group derivation, the self-approval rule, and how many PRs to split it into.
The suggested order is:

1. Schema, migration and resolver.
2. Approval RPCs.
3. The page.
4. Picker and place dialogs.
