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

## Ruling 2026-10-25 � Mainland Pest Control under R&M; group charge catalog

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
