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
Organization (organizations)            -- who is accountable / who is custodian
  └── Place = House (locations)         -- ONE physical place; the anchor of accountability
        ├── Site facet (client_sites)   -- the addressed facet: building, parcel, boundary polygon
        └── Zone facet (location_zones) -- the activity-area facet: camping area, street parking,
              └── Checkpoint (patrol_checkpoints)   reserve; module_key + schedule + rules
                    -- ~5 m verification point INSIDE a site or zone; presence proof
```

- **A place is one house.** The house (`locations`) is the accountability anchor
  the `FOUNDATION.md` anchor rule points at: the *place of harm* and the place a
  client's operational truth stays with when providers change.
- **Site and Zone are facets, not children of each other.** A house may have a
  site facet, one or more zone facets, or both. A zone may sit over many
  addresses or none; a site is exactly one addressed parcel.
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

## Live facts (2026-09-14)

| Fact | Value |
|---|---|
| `locations` (houses) | 9 rows |
| `client_sites` | 79 rows; 10 carry `location_id`; 4 have `boundary_verification = 'verified'` |
| `location_zones` | 16 rows; 15 carry `location_id`; 13 verified; columns include `module_key`, `onsite_profile`, `active_schedule`, `rule_overrides`, parking limit fields |
| `site_services` | 14 rows, `site_id` and `zone_id` both present |
| `location_events` | 0 rows (dormant) |
| Place access function | `has_location_access(site_id, zone_id, direction)` present live; used by additive SELECT policies on the place layer |

Reading: the house model is **adopted for new places and partially back-filled**
(69 of 79 sites have no house yet). Convergence is data migration plus a rule
that every site/zone create path resolves-or-creates a house first (the
`resolveOrCreateHouse` path in the lineage, guarded against ownership jumps).

## Rules

1. Exactly one Site table (`client_sites`), one Zone table (`location_zones`),
   one House table (`locations`). No parallel place model in any module.
2. New places: resolve-or-create the house, then the facet. Never a facet
   without a house from here on.
3. Module rules attach to the zone facet as data (`module_key`, `active_schedule`,
   `rule_overrides`, `jurisdiction_rule_sets`), never as a forked geometry.
4. Accountability records (observations, assessments, incidents, notices) anchor
   to the place of harm through the site/zone FK and the harmed-party columns
   (`docs/canon/ALIGNMENT_LEDGER.md` W2), and become readable to the harmed party
   through `has_location_access` / `user_has_task_entitlement` (W1).
5. Verify columns against `supabase/schema.sql` (regenerated from live) before
   any migration touching these tables.
