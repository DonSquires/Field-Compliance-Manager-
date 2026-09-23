# Location "House" Model — sites and zones as facets of one place

> Canon. Reconciles two GitLab-lineage documents that drifted apart —
> `docs/LOCATION_HIERARCHY.md` (2026-07, "site and zone are siblings; retire
> `locations`") and the later house-model ruling recorded in
> `docs/ORG_SERVICE_MODEL.md` (migration 0145 / 0312 in that lineage: "`locations`
> is the house; `client_sites` and `location_zones` are its Site and Zone facets;
> the table names are LEGACY and were repurposed, not renamed"). The later ruling
> wins. Live facts below were verified against project `dotczcyyzgabmtmnglqj` on
> 2026-09-14. Sits below `FOUNDATION.md` and `docs/canon/ACCESS_DOCTRINE.md`.

## The model

```
Place registry (canonical_places)       -- ONE permanent row per real-world place; anyone can search it
  kind = site  : a literal address / LINZ lot, keyed by its address
  kind = zone  : an area (a street, beach, river), keyed by the house that made it
        ▲ linked to by
Organization (organizations)            -- who is accountable / who is custodian
  └── House (locations)                 -- the organisation's link to ONE registry place
        ├── Site facet (client_sites)   -- the addressed facet: building, parcel, boundary polygon
        └── Zone facet (location_zones) -- the activity-area facet: camping area, street parking,
              └── Checkpoint (patrol_checkpoints)   reserve; module_key + schedule + rules
                    -- ~5 m verification point INSIDE a site or zone; presence proof
```

- **A place is one registry row.** `canonical_places` is the registry: a location
  is a permanent thing on a map, like an organisation is a permanent thing in the
  CRM. There is only ever one of it. Organisations do not own it; they link to
  it to do work.
- **A house is a link, not a second place.** `locations` is the organisation's
  handle on a registry place (`locations.canonical_place_id`, required). Two
  organisations at the same address each have their own house pointing at the
  **same** registry row; the anchor rule in `FOUNDATION.md` (the place of harm
  stays with the client when providers change) is satisfied because the
  identity is shared, not forked.
- **Site and Zone are facets, not children of each other.** A house may have a
  site facet, one or more zone facets, or both. A zone may sit over many
  addresses or none; a site is exactly one addressed parcel. A zone never hangs
  off a site (`location_zones.site_id` was removed) and never nests
  (`parent_zone_id` was removed). Sibling zones of a site are the zones on the
  same house (`zones_for_site`).
- **Every facet has a house; every house has a registry row.** Enforced by
  triggers on write: a facet created without `location_id` gets the owner
  organisation's house by address key (sites) or name (zones), else a new one;
  a facet may never hang off another organisation's house.
- **Legacy names.** `client_sites` does **not** mean "client-owned sites" and
  `location_zones` does not mean "zones under locations" — read them as `sites`
  and `zones`. `client_sites.client_organization_id` is the **owner org of the
  place**. They were repurposed, not renamed, to avoid a wide rename across RLS,
  RPCs, edge functions, the web app and Bob's knowledge. Do not start that rename
  casually; it is a governed, Atlas-blast-radius change.
- **Overlapping, time-aware module geofences live on the Zone facet.** One
  boundary may host `freedom_camping` overnight and `parking` daytime as two
  `location_zones` rows with the same geometry, different `module_key` and
  `active_schedule`, `onsite_profile` (`boundary` | `approach_10m`) and
  `rule_overrides`. Geometry is shared; module is data on top
  (`docs/canon/PLATFORM_ENGINES_AND_MODULE_PROFILE.md` §2).
- **Per-place service selection** is `site_services(module_key, site_id XOR
  zone_id, service_agreement_id, enabled, config)`. This is the `place_services`
  concept from the lineage under its live name; do not create `place_services`.
- **Three-layer gating (compose, never collapse):** org bought it
  (`organization_modules` / `org_module_subscriptions`) → place uses it
  (`site_services`) → person may touch it (`user_profiles.module_access` +
  access doctrine). A surface shows only when all three align.
- **Boundaries are unverified until visually confirmed** (`boundary_verification`
  on sites and zones, `jurisdiction_verification` on organizations) and an unset
  or unverified boundary is a loud, first-class state — see
  `docs/canon/GEOFENCE_PRINCIPLES.md` P1/P2.

## Events

`location_events` is the intended single per-place activity stream (site XOR
zone, optional checkpoint, `event_type`, `module_key`, `payload`). **Live it has
0 rows** — module detail tables (`observations`, `noise_assessments`,
`parking_chalk_records`, `incidents`, ...) are written directly and nothing
dual-writes the stream. Until a governed writer exists this is a *seam*, and no
UI may present it as live data (`apps/web/src/pages/ComingSoonPage.tsx` is the
convention for genuinely unbuilt surfaces).

## Owner ruling 2026-09-15 — registry, permanence, one key rule

> "A location house is a permanent location like on a map; anyone can search for
> them and create a link to do work, just like an org. There is only ever one org
> and only one location, whether it is a site or a zone. Sites are more specific:
> a literal address, a LINZ lot. Zones are normally org-created to accommodate
> compliance-enforcement areas — a street for parking enforcement, freedom
> camping on a beach or river. These will never be deleted: once they are in the
> canonical table they remain there for anyone to search and use."

Applied by migration `20260915170000_place_model_convergence.sql` (live, ledger
recorded; proven by `supabase/tests/20260915170000_place_model_convergence.sql`):

1. **Registry keys.** `canonical_places.place_kind ∈ {site, zone}`. A site row is
   keyed `site:<address_match_key>` so the same address in any organisation is
   one place; a zone row is keyed `zone:<house id>`. Facets inherit their house's
   `canonical_place_id` (`ensure_canonical_place_for_projection`).
2. **Permanence.** `DELETE`/`TRUNCATE` on `locations`, `client_sites`,
   `location_zones`, `canonical_places`, `canonical_place_links` is revoked from
   `anon`/`authenticated` and blocked by trigger for everyone else. The only
   exceptions are the test-dataset purge (`app.place_delete_scope =
   'test_dataset_purge'`, set by `purge_aam_e2e_dataset`) and a service/admin
   rollback of a row created in the last 15 minutes (proposal compensation).
   Duplicates are converged with `merge_canonical_place(from, into)` — the loser
   is marked `merged` and every reference is re-pointed; nothing is removed.
   Retire with `status = 'retired'`; never delete.
3. **One address key rule.** `public.address_match_key(text)` (lowercase, every
   non-alphanumeric run removed) is applied by trigger on every `locations` and
   `client_sites` write; `supabase/functions/_shared/addressKey.ts` mirrors it and
   is pinned to the SQL definition by `test/place-model-convergence.test.js`. The
   key is exact: "37 Halifax Street" and "37 Halifax Street, Nelson 7010" are
   different keys, which is why LINZ canonical addresses are the only site entry
   path (GEOFENCE_PRINCIPLES Q10).
4. **Cross-organisation address is not a conflict.** The former tri-state
   `check-house-conflict-any-org` hard stop in `_shared/houseResolve.ts` is
   removed; `manage_crm_location` returns the organisation's existing house for a
   repeated address and allows another organisation's address.
5. **Removed as duplicates of one fact:** `location_zones.site_id`,
   `parent_zone_id`, `boundary_legacy`, `repeat_stay_radius_meters`, `address`,
   `suburb`, `postcode`, `address_match_key`; table `client_site_zones`;
   `get_zone_for_gps` (a P1-violating copy of `resolve_context`). A zone's
   address is its house's address. `client_sites.gps_lat/gps_lng` remain for
   existing readers but are derived from `center_point` by trigger — do not write
   them.
6. **Test data stays.** Duplicate test organisations and their places are not
   deleted; identity convergence happens only at the registry layer.

## Ruling correction 2026-09-23 — `parent_zone_id` reinstated for same-org zone hierarchy

> Owner clarification (2026-09-23): the 2026-09-15 rebuild that produced this
> canon was done from the live Supabase schema alone — GitLab and GitHub
> lineage were not available at the time, so item 5 above ("never nests")
> was a simplification made without knowing why the removed column existed.

Checked against the lineage now (`DonSquires/FreedomCamp-Manager`,
`src/lib/zoneResolution.ts`, `src/lib/geofence.ts`,
`src/components/features/ZoneHierarchyManager.tsx`,
`get_zone_compliance_breakdown`): `zones.parent_zone_id` + `zone_type ∈
{general, specific}` was a real, working, proven feature — a broad area
(`general`, `parent_zone_id IS NULL`) containing many named sub-areas
(`specific`, `parent_zone_id` set), used for compliance breakdown, child-zone
priority in GPS resolution, and officer shift zone display. This is a
genuinely different concern from `GEOFENCE_PRINCIPLES.md`'s four-tier model
(Tier 1 `organizations.jurisdiction_geom` containing Tier 2 zones is a
**cross-organisation** jurisdiction relationship — a council's overall
boundary containing many independent operators' zones). The prototype's
pattern is **same-organisation** zone subdivision — one estate (a forestry
block, a large reserve) split into many named sub-areas that are all one
org's zones. Confirmed live need: R&M's forestry clients' patrol logs record
activity against dozens of named forest sub-blocks (e.g. OFO's "Golden Downs
Forest" contains "Te Hepe", "Berrymans", "Cains", and more — verified against
R&M's own real forestry maps) that have no independent address and are not
sensibly modelled as dozens of new top-level zones.

**Correction:** `location_zones.parent_zone_id` (`uuid references
location_zones(id) on delete set null`, nullable) is reinstated, scoped
narrowly:

- A zone's `parent_zone_id`, when set, must reference another zone on the
  **same** `organization_id` (a zone never nests under another organisation's
  zone — that part of the original ruling stands).
- This is a grouping/attribution/reporting relationship only — it does
  **not** feed `resolve_context`'s P1/P2 tier resolution or geofence
  containment. A visit to a child zone still resolves and verifies exactly as
  a flat zone always has; `parent_zone_id` only lets a report roll a child
  zone's activity up to its parent estate. Wiring it into geofence
  containment/resolution is a separate future ruling if ever needed — do not
  assume it happens automatically.
- Site facets are unaffected: a zone still never hangs off a site, and
  `client_sites` still never nests.

## Ruling correction 2026-09-23 (later same day) — `active_build_cleanup` delete scope

> Owner ruling: "while we are building and seeding, you have permission to
> delete, we want a clean db."

The 2026-09-15 permanence rule is right for *real* places — anything a person
has ever searched for, linked to, or recorded activity against must never
silently disappear. It is the wrong rule for a genuine seeding-bug artifact
that was never real: e.g. a duplicate-loop bug in an import script created
145 empty `location_zones` rows (same names, zero code ever pointed at them,
zero `observations`/`location_events`/`parent_zone_id`/`workshop_work_orders`/
`service_agreement_locations` references — confirmed by direct query before
any deletion) minutes after the correct rows were created. Retiring
(`is_active = false`) such rows leaves permanent clutter in `location_zones`
for something that was never a place at all.

`tg_place_permanence()` gained one more explicit, narrow, opt-in scope
alongside the existing `test_dataset_purge` one:
`current_setting('app.place_delete_scope', true) = 'active_build_cleanup'`
(migration `20260923130000_active_build_cleanup_place_delete_scope.sql`).
This is a caller discipline, not a mechanically-enforced one — exactly like
the pre-existing 15-minute compensating-transaction exception this function
already trusts. Before setting this scope and deleting, verify (don't
assume) that the target rows have zero real references anywhere they could
plausibly be pointed at — the same check performed for the OFO duplicate
zones above. This scope is for active build/seed sessions cleaning up their
own bugs, not a general-purpose "delete a place" escape hatch — the
2026-09-15 permanence rule still stands for anything with real history.

## Provenance (2026-09-23) — this model is the real ratified "v2 house model", not a reconstruction guess

> This file previously carried no GitLab provenance header, unlike almost
> every other file in `docs/canon/` (19 of 23 were already pulled on
> 2026-09-14). Read at source now
> (`docs/proposals/CANONICAL_PLACE_ANCHOR_V2_HOUSE.md`, owner-ratified
> 2026-08-05, 5-lens investigation by Jim/2iC, with a self-correcting
> "foundation-walk gap audit" follow-up dated 2026-08-06) — access had been
> lost before this file got its turn in the 2026-09-14 pass, so it was
> rebuilt from live schema alone on 2026-09-15 instead.

The good news: the 2026-09-15 rebuild **independently converged on the same
real decision** — `locations` (the house) is the canonical place anchor;
`client_sites`/`location_zones` are facets attached by `location_id`, not
siblings attached by a zone's own `site_id`. Even the same historical orphan
(the "Lowburn" Downer/LINZ case, both anchors null) shows up in both the
GitLab investigation and this repo's live "Live facts" table below — it is
the same real row, independently rediscovered.

**One precision this repo's rebuild did not have, worth stating explicitly**
(from the ratified proposal's own self-correcting gap audit, GAP 1): the
site facet is a **route** to the house, never a co-equal fallback owner.
Do not write ownership-resolution logic as `COALESCE(house, site)` — that
framing was explicitly proposed once, caught by the owner's own audit, and
retracted as "doctrinally wrong". Always resolve ownership through the
house (`locations.organization_id`); `client_sites`/`location_zones` are
how a user reaches it, not a second place of truth for it.

**One thing this repo's rebuild added that the original GitLab ruling did
not cover:** `canonical_places`, the cross-org registry sitting BELOW the
house (one real-world place, searched and linked by many organisations'
houses). The 2026-08-05 proposal ratified the house (`locations`) as
canonical for a SINGLE organisation's view of a place; it does not mention
a cross-org registry beneath it. Treat `canonical_places` as a genuine,
sound extension built on top of the real ratified house model — not a
contradiction of it, and not something to remove for "not being in the
lineage".

## Live facts (2026-09-15, after the migration)

| Fact | Value |
|---|---|
| `canonical_places` | 79 rows: 77 site + 1 zone active, 1 merged (the Lowburn fork); every active row has a point or boundary |
| `locations` (houses) | 79 rows, every one with `canonical_place_id`; one address shared by two organisations (Lowburn) resolves to one registry row |
| `client_sites` | 79 rows, every one with `location_id` in its owner organisation |
| `location_zones` | 16 rows, every one with `location_id` in its organisation |
| Observations anchored to the registry | 3,113 (all on the Lowburn registry row, uuid preserved) |
| Place access function | `has_location_access(site_id, zone_id, direction)` present live; used by additive SELECT policies on the place layer |

## Rules

1. Exactly one registry (`canonical_places`), one House table (`locations`), one
   Site table (`client_sites`), one Zone table (`location_zones`). No parallel
   place model in any module, and no second column for a fact a sibling table
   already holds.
2. New places: the facet write resolves-or-creates the house and the house
   resolves-or-creates its registry row — by trigger, not by caller discipline.
   Never a facet without a house; never a house without a registry row.
3. Module rules attach to the zone facet as data (`module_key`, `active_schedule`,
   `rule_overrides`, `jurisdiction_rule_sets`), never as a forked geometry.
4. Accountability records (observations, assessments, incidents, notices) anchor
   to the place of harm through the site/zone FK and the harmed-party columns
   (`docs/canon/ALIGNMENT_LEDGER.md` W2), carry the registry identity in
   `canonical_place_id`, and become readable to the harmed party through
   `has_location_access` / `user_has_task_entitlement` (W1).
5. Places are permanent (ruling above). Converge duplicates with
   `merge_canonical_place`; retire with status; never delete.
6. Verify columns against `supabase/schema.sql` (regenerated from live) before
   any migration touching these tables.
