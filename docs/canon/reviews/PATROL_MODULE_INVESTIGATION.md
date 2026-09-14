> **Canonical copy.** Origin: GitLab `don-squires1/field-compliance-manager` `` @ `Main`, read 2026-09-14 via `scripts/gitlab-read.mjs`. This repository (`DonSquires/Field-Compliance-Manager-` `main`) is the authoritative home from now on; the GitLab text is lineage. Edit here and record the ruling — never fork the text. Links to files that do not exist in this repo refer to that lineage.

# Patrol Module Investigation — New Build vs Old Build, and Plan

**Date:** 2026-06-27
**Author:** GitLab Duo (session 3)
**Scope:** Full audit of the patrol module in the new build (this repo) and the old
build (`don-squires1/FreedomCamp-Manager`), a gap analysis, and a reconciliation plan.

---

## TL;DR

There are **two parallel, disjoint patrol paradigms** present, and the live DB carries
both:

1. **Route/Stop Engine** (new, migration `0030_patrol_engine.sql`) — the real,
   sophisticated patrol system: named routes → per-site visit configs → generated
   shift stops → OSRM + OR-Tools optimisation → live SLA tracking. This is the
   intended backbone.

2. **Checkpoint/Visit** (old, ported from `FreedomCamp-Manager`) — a QR/NFC
   lone-worker checkpoint model (`patrol_checkpoints` + `patrol_checkpoint_visits`).
   I recently built admin + officer UI on this (!249, !253, !255, !259).

**They do not connect.** `shift_stops` (engine) and `patrol_checkpoints` (checkpoints)
have no relationship, and the live `patrol_checkpoint_visits` is a **stripped-down**
version of the old richer table.

**Recommendation: do NOT do a destructive redesign.** Both paradigms are legitimate and
serve different needs. Reconcile them with a thin linking layer and keep the route engine
as the primary system. Details below.

---

## 1. New build patrol module (this repo)

### Schema (`supabase/migrations/0030_patrol_engine.sql`)

| Table | Purpose |
|-------|---------|
| `patrol_routes` | Named, permanent runs (e.g. 587 Nelson City Night Patrol). Code, route_type, default shift/time, active_days, colour. |
| `patrol_route_sites` / `patrol_route_zones` | M:N coverage of a route over sites/zones (migration 0022). Has `preferred_stop_order`, `dwell_minutes`, `sla_arrive_within_minutes`. |
| `client_site_patrol_config` | Per-site visit schedule on a route: module, active_days, visits_per_shift, min_gap, time_window (fixed / sunrise_sunset / seasonal), dwell, SLA arrive/depart, preferred_stop_order, officer_instructions, required_actions. |
| `shift_stops` | Materialised stop list per published shift. One row per visit. Locked SLA windows, live ETA/travel/sla_status, actual arrive/depart, lifecycle status. |
| `shift_stop_actions` | Module-specific actions completed at a stop (scan, checkpoint, photo, etc.). Polymorphic result reference. |
| `patrol_solve_cache` | Cached OSRM matrix + OR-Tools solution per shift, with shift_health and TTL invalidation. |
| `patrols` | Patrol session record (shift_id, officer, location, zone, status). Shared with the checkpoint model. |

### RPCs
- `generate_shift_stops(shift_id, date)` — builds `shift_stops` from configs, applies
  day-of-week + seasonal filters, locks SLA windows.
- `insert_adhoc_stop(...)` — inserts a dispatch job as a stop, invalidates solve cache.
- `complete_shift_stop(...)` — marks a stop complete, updates shift counters.

### Backend (`apps/api/src/patrolEngine.ts`)
- `POST /api/patrol/generate-stops` — generate + fill sunrise/sunset windows.
- `POST /api/patrol/optimise` — OSRM `/table` matrix → `fcm-solver` (OR-Tools) → write ETAs.
- `POST /api/patrol/insert-adhoc` — adhoc job, re-solve, SLA impact report.
- `POST /api/patrol/update-eta`, `POST /api/patrol/complete-stop`.
- Self-contained sunrise/sunset calc (no external API). Internal Docker services
  `osrm:5000` and `fcm-solver:5001`.

### Frontend
- `PatrolRoutesPage` (admin) — route CRUD + assembled stop list from configs, SLA
  summary, manual stop ordering. Configs are created in CRM → Sites → Patrol Schedule.
- `PatrolPage` (officer) — stop-by-stop view: ordered stops, ETAs, SLA countdown
  (green/amber/red), navigate, arrive/complete, adhoc notifications, per-module action
  checklist (`MODULE_ACTIONS`).

### Maturity
**High.** This is a contract-grade patrol engine (SLA clocks, proof, optimisation). It
maps directly to Layer 3 contract-performance needs (NCC facility frequency matrix).
Likely needs: the solver/OSRM services actually deployed, and the officer Start/End +
stop completion wired to `complete_shift_stop` (partly done via !263).

---

## 2. Old build patrol module (`FreedomCamp-Manager`)

### Checkpoint schema (`20260302000003_patrol_checkpoints.sql`)
- `patrol_checkpoints`: `zone_id`, `qr_code` (unique), `nfc_tag_id`, `location_lat/lng`,
  `required_on_patrol`, `check_in_radius_metres` (default 50), `is_active`.
- `checkpoint_visits` (immutable, chain-of-custody): `checkpoint_id`, `officer_id`,
  `patrol_id`, `scan_method` (qr_camera / nfc / manual_code / url_deep_link),
  `gps_latitude/longitude`, `gps_accuracy`, `gps_distance_from_checkpoint`,
  `within_radius`, `visited_at`, `notes`.
- Framed explicitly as **Lone Worker Protocol (Health & Safety at Work Act 2015)**.
- Related old migrations: `20250212000004_patrol_notifications_geofence.sql`,
  `20250201000001_geofencing_enhancements.sql`, `20250201000002_officer_welfare_system.sql`,
  `20260302000001_man_down_detection.sql`.

### Paradigm
The old build's patrol was **checkpoint + geofence + welfare** centric (prove presence at
physical points, lone-worker safety), NOT route optimisation. No OSRM/OR-Tools, no
SLA-windowed stop engine.

---

## 3. The drift / conflict

| Concern | New engine | Old checkpoints | Status on live DB |
|--------|-----------|-----------------|-------------------|
| Expected stops | `shift_stops` (from configs) | `patrol_checkpoints` (`required_on_patrol`) | Both tables exist, unrelated |
| Actual presence | `shift_stop_actions` + stop arrive/depart | `checkpoint_visits` | Live `patrol_checkpoint_visits` is the OLD model but **stripped** |
| Visit richness | n/a | scan_method, accuracy, distance, within_radius, notes | **LOST** on live (only patrol_id, checkpoint_id, officer_user_id, gps_lat/lng, visited_at) |
| Linkage | route → config → stop | checkpoint → visit | **No link between the two models** |

**Why missed-checkpoint detection is currently impossible:** the "expected" sequenced
model (`patrol_route_checkpoints`) is disjoint from the "actual" visits
(`patrol_checkpoint_visits.checkpoint_id` → `patrol_checkpoints`, the ad-hoc table). And
neither checkpoint table links to `shift_stops`.

---

## 4. Plan (phased, non-destructive)

### Principle
Keep the **route/stop engine as the primary patrol system** (it is the contract-grade
backbone and Layer 3 depends on it). Treat **checkpoints as a complementary lone-worker
proof layer** that attaches to stops, not a competing system. No table drops.

### Phase P1 — Restore checkpoint richness (small migration)
The live `patrol_checkpoint_visits` lost columns the old model had and the UI/H&S needs.
Add (idempotent, `ADD COLUMN IF NOT EXISTS`): `scan_method`, `gps_accuracy`,
`gps_distance_from_checkpoint`, `within_radius`, `notes`; and on `patrol_checkpoints`:
`required_on_patrol`, `check_in_radius_metres`, `nfc_tag_id`. Update the officer scan
(!255) to compute distance + within_radius and record scan_method.

### Phase P2 — Link checkpoints to the engine
Add `shift_stop_id uuid references shift_stops(id)` to `patrol_checkpoint_visits` (and
optionally a `checkpoint_id` to `shift_stops` for "this stop is verified by scanning
checkpoint X"). This lets a checkpoint scan satisfy a stop and become a
`shift_stop_action` (action_type 'checkpoint_scan').

### Phase P3 — Missed-checkpoint / missed-stop detection (now possible)
With P2's link: for an active/completed shift, expected `shift_stops` (or
`required_on_patrol` checkpoints) with no matching visit/action within the SLA window =
missed. Surface in the Live Patrol Monitor (!245) and notify supervisor (reuse the
welfare-alert pattern).

### Phase P4 — Deploy the engine services
The optimisation path needs `osrm` and `fcm-solver` running (docker-compose.full.yml on
the VPS). Until then, `PatrolPage` should fall back to `preferred_stop_order` (manual
order) instead of solved ETAs — confirm the fallback works without the solver.

### Phase P5 — Decide checkpoint vs route-checkpoint model
Two "expected checkpoint" tables exist (`patrol_checkpoints` ad-hoc, and
`patrol_route_checkpoints` sequenced). Pick one as canonical for route-bound checkpoints.
Recommendation: keep `patrol_checkpoints` for ad-hoc/standalone QR points (what the
current UI uses) and treat `patrol_route_checkpoints` as the engine's sequenced stops
(fold into / align with `shift_stops`). Migrate or deprecate the unused one.

---

## 5. Redesign decision

**No destructive redesign required or advised.** The new engine is well-designed and the
checkpoint layer is useful and already has working UI. The correct move is **integration,
not replacement**: small additive migrations (P1, P2) to restore richness and link the
models, then the previously-blocked features (P3 missed-detection) become possible.

Destructive options (dropping the checkpoint tables, or dropping the engine) are both
wrong: dropping checkpoints throws away working lone-worker H&S proof + UI; dropping the
engine throws away the contract-grade SLA/optimisation backbone Layer 3 needs.

---

## 6. Immediate next steps (proposed order)
1. **P1 migration** (restore checkpoint columns) + update officer scan to populate them.
2. **P2 migration** (link `patrol_checkpoint_visits.shift_stop_id`).
3. **P3** missed-detection in Live Patrol Monitor.
4. **P4** confirm `PatrolPage` solver-less fallback; schedule osrm/solver deploy.
5. **P5** canonical checkpoint model decision (needs owner sign-off; touches data model).

> Each migration must follow the standing rule: check `docs/db/LIVE_SCHEMA.md` (refresh
> if stale) before writing, because the live DB carries remote-applied tables not all in
> repo migrations.
