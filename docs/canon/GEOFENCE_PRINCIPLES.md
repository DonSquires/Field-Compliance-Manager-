# Geofence Principles — the load-bearing engine

> Canon (distilled). Origin: GitLab `docs/design/GEOFENCE_SYSTEM_REDESIGN.md`
> (2,820 lines, ratified 2026-07-22; owner rulings recorded verbatim from MR
> !1051) and `docs/GEOFENCE_ARCHITECTURE.md` in the same lineage. Read the full
> text with `node scripts/gitlab-read.mjs dump - docs/design/GEOFENCE_SYSTEM_REDESIGN.md`.
> This distillation keeps every ruling and principle; it drops the 2026-07
> current-state audit of GitLab code. "Live" facts were verified against project
> `dotczcyyzgabmtmnglqj` on 2026-09-14.

## Why this is an engine, not a feature

> Owner ruling (migration 0212): "this whole app is triggered by geofences; it is
> simply a boundary that triggers activity and models — step back and see it for
> what it is BEFORE reaching for a domain-specific rule."

A boundary is **domain-blind**. It triggers activity, reveals which modules apply
at a point-and-time, supplies the governing ruleset, anchors evidence, and (via
zone tiers) prices the work. Geofence correctness therefore *is* billing
correctness *is* enforcement legality. Modules are attributes layered on the
boundary as data, never a fork of the geometry
(`docs/canon/PLATFORM_ENGINES_AND_MODULE_PROFILE.md`).

## P1 — Load-bearing, no silent fallbacks

> Owner ruling (MR !1051): the entire build depends on the geofence being present
> AND accurate. There are NO fallbacks. The design must be solid and foolproof.

It must be structurally impossible for a geofence to be silently missing or
wrong yet consumed as authoritative. "No geofence set", "geofence unverified",
"geometry invalid" and "point outside all geofences" are **four different
answers** and must never collapse into one empty result. `resolve_context`
returns `resolution_status`:

| `resolution_status` | Meaning | Posture |
|---|---|---|
| `resolved` | matched a verified boundary | proceed |
| `unresolved_no_geofence` | no geometry at all | LOUD: configure before proceeding |
| `unresolved_unverified` | geometry exists, not visually verified | LOUD: verify on map first |
| `unresolved_invalid` | `ST_IsValid` false / empty | LOUD: redraw or re-import |
| `outside_all_geofences` | verified geometry exists; point is outside | valid operational result |

Callers (scan pipeline, dispatch, billing tier, enforcement) must branch on this
status. A `false`/`NULL` is never an answer.

## P2 — Visual verification gate

> Owner ruling (MR !1051, confirmed across Q3 and Q6): all geofence settings must
> be verified by the user visually on the actual map.

Every boundary from **any** origin (NZTA, Google, LINZ parcel, council ArcGIS,
user-drawn, Bob-extracted from an uploaded map, point + radius) lands
`unverified` and is not consumed by `resolve_context`, billing or enforcement
until it is **present**, **valid** and **visually verified** by a human
(`verified_by`, `verified_at`, history in `geofence_boundary_history`).

| Entity | Table | Verification column |
|---|---|---|
| Org jurisdiction | `organizations` | `jurisdiction_verification` |
| Zone facet | `location_zones` | `boundary_verification` |
| Site facet | `client_sites` | `boundary_verification` |
| Checkpoint | `patrol_checkpoints` | `checkpoint_verification` |

Every write path (`set_org_jurisdiction_geom`, `set_zone_geometry`,
`set_site_geometry`, `save_zone_boundary`, `save_site_boundary`, checkpoint
create/update) resets the state to `unverified`. Only the map-confirm action flips
it to `verified`.

## The four-tier hierarchy and three resolution layers

```
Tier 1  provider / council jurisdiction   organizations.jurisdiction_geom  (MultiPolygon)
Tier 2  zone facet                        location_zones.boundary          (module_key, active_schedule)
Tier 3  site facet                        client_sites.boundary            (Polygon)
Tier 4  checkpoint                        patrol_checkpoints               (~5 m point + radius)
```

Nesting is advisory proximity, not hard containment — real GPS is noisy and hard
containment would reject valid scans.

`resolve_context(p_lat, p_lng, p_org_id, p_module_key, p_at)` resolves in three
layers: **L1 operating bounds** (provider jurisdiction contains the point) →
**L2 governing council** (smallest containing jurisdiction; supplies
`jurisdiction_rule_sets` for the module, border auto-switch) → **L3 site/zone**
(verified boundary, filtered by `module_key` and `active_schedule`, child beats
parent; `onsite_profile` decides `boundary` vs `approach_10m`). It returns
`in_operating_bounds`, governing jurisdiction, `on_site`, `site_id`,
`client_org_id`, `matched_zone_id`, `matched_module_key`, `effective_rules`
(jurisdiction base + zone columns + overrides), `resolution_status`,
`governor_overlap_flag`. `resolve_context_authorized` is the caller-scoped
wrapper the apps use.

Overlapping, time-aware module geofences are first-class: two `location_zones`
rows can share one geometry with different `module_key` + schedule (freedom
camping overnight, parking daytime). Zones (area + rules) and checkpoints (point
+ QR, always tied to a site) are structurally separate.

## Owner rulings Q1–Q10 (binding)

- **Q1 Canonical TA names** — from the most recent authoritative source
  (NZTA/Stats NZ), fetched live and cached in `canonical_ta_names`; never a
  hard-coded or 2013 list.
- **Q2 Area gate** — soft warning only. The UI must show unambiguous set /
  not-set / provisional status and open the draw-on-map entry point when a
  boundary is missing or failed.
- **Q3 Checkpoints** — direct save (manual or Bob-extracted), but always subject
  to P2 visual verification. No proposal flow.
- **Q4 Versioning** — every boundary of every entity type is versioned in
  `geofence_boundary_history`, including who verified and when.
- **Q5 Governance is structural** — organisation + jurisdiction boundaries are
  SENSITIVE and always governed (propose → review → approve → execute, with map
  preview); zones and sites are direct-save through the map editor. No per-org
  `authorization_mode` toggle for geofences. Bob acting as proposer is still
  governed.
- **Q6 Source outage** — fall through the ladder NZTA → Google → Stats NZ /
  Koordinates / council ArcGIS (`geo_source_registry`) → user-drawn → point +
  radius. Every rung lands `unverified`; record the source; never silently
  degrade; if all fail, say so loudly and leave the boundary unset.
- **Q7 Zone geometry** — `MultiPolygon(4326)`, `ST_MakeValid` + `ST_Multi` on
  write, GiST index, never lossy `ST_ConvexHull`.
- **Q8 Provisional radii** — org-configurable in `org_geofence_config`
  (platform fallbacks 50 m site / 100 m zone / 5 m checkpoint only when unset),
  optionally per `zone_type`.
- **Q9** — superseded by Q5.
- **Q10 No free-hand addresses** — every address entry routes through LINZ
  `address_autocomplete` → canonical address + point → `boundary_for_point`
  (Google secondary) through ONE canonical site-entry pipeline (lookup → dedup →
  onboarding/site-create → return site). Dispatch is not a special case; it is
  site-entry plus a route-assignment step.

## Live status (2026-09-14)

| Element | Live | Note |
|---|---|---|
| `resolve_context` / `resolve_context_authorized` | present; return `resolution_status` and `governor_overlap_flag`; L3 filters `boundary_verification = 'verified'`, `module_key`, `_geofence_active_at(active_schedule, p_at)` | P1 + P2 implemented in SQL |
| `jurisdiction_verification`, `boundary_verification` columns | present on `organizations`, `client_sites`, `location_zones` | 13 of 16 zones and 4 of 79 sites verified |
| `org_geofence_config`, `geofence_boundary_history`, `canonical_ta_names` | present | Q8, Q4, Q1 substrate exists |
| Callers branching on `resolution_status` | `process-officer-scan` conformed 2026-09-15 (fails closed on no row; distinct notice per outcome persisted on `observations.geofence_context` and returned to web + mobile); dispatch intake requires resolved coordinates; no billing zone-tier resolver exists live yet | `test/geofence-p1-callers.test.js` guards the branching |
| Workbench engine (`boundary_proposals`, `propose_/accept_/reject_boundary_proposal`, `get_geofence_review_queue`) | live (`20260914004000`) | P2 for every source; truth table 42 checks |
| `verify_boundary` refuses missing/invalid geometry (all four tiers) | live (`20260914140000`, applied 2026-09-15) | `verified` now means present + valid + human-confirmed, versioned in history |
| Tier 4 checkpoints: governed direct save, structural P2 reset trigger, server-measured visits | live (`20260915100000`, applied 2026-09-15) | `manage_patrol_checkpoint`; `trg_patrol_checkpoints_geometry_guard`; `record_officer_checkpoint_visit` measures presence server-side and records the verification state at visit |
| Canonical site-entry pipeline (Q10) | dispatch slice live (`20260914130000`, both dispatch place writers share `resolve_or_create_dispatch_place_site`); other address entry points still separate | audit item in `docs/REBUILD_PLAN.md` §3.3 |

## Rules for every future change

1. Never add a fallback that turns an unset/unverified boundary into a silent
   default. Surface the `resolution_status`.
2. Never write geometry without resetting verification to `unverified`.
3. Never fork geometry per module. Add a zone row / `module_key` / schedule.
4. Never take a free-hand address. Route through the canonical pipeline.
5. Blast-radius check (Atlas + `supabase/schema.sql`) before touching
   `resolve_context`, the boundary columns, or their writers — they carry billing
   and enforcement.
