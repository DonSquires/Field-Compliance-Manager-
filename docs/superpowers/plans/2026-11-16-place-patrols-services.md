# Place Patrols & Services (Part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An administrator opens a place in Operational setup and, from one tab, sets up its patrols (work unit, days, windows incl. sunrise/sunset and random days, months, checks), static guarding posts and briefings, with every change kept as a dated, optionally approved version of the client agreement's terms.

**Architecture:** New SECURITY DEFINER RPCs keyed on the place (`location_id`) write immutable `place_service_term_versions` rows and project the version in force onto the existing `service_agreement_delivery_schedules` / `client_site_patrol_config` rows. `generate_shift_stops_internal` reads the terms in force on the shift date (solar windows, seeded random days, required checks). The web UI is a new **Patrols & services** tab plus a **Briefing** tab inside `OperationalPlaceManager`; officers record checks per stop on web and mobile.

**Tech Stack:** PostgreSQL 17 + PostGIS (Supabase), plpgsql, pgcrypto (`extensions` schema), pg_cron; React + TypeScript (Vite, Vitest, Playwright) in `apps/web`; React Native in `apps/mobile`; Node `node:test` migration tests on disposable PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-11-16-place-patrols-services-and-rates-design.md` (Part A only; Parts B and C get their own plans).

## Global Constraints

- Releases: signed commits as `DonSquires <squires.don@gmail.com>` with the `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer; pull request only; merge with `gh pr merge <n> --rebase` after CI is green. Never push to `main`.
- Never hand-edit `supabase/schema.sql`; it is regenerated after the release.
- "A site and a zone are equal." No flow may require a Site when a zone will do.
- Every new SECURITY DEFINER function: `SET search_path=''`, checks `auth.uid()`, checks `public.is_admin_for_org(<provider>)` (or the descendant rule in Task 2), then `REVOKE ALL ... FROM PUBLIC, anon;` and `GRANT EXECUTE ... TO authenticated;` (internal helpers: grant to nobody but `service_role`).
- The random-draw seed is never readable through the Data API: RLS on, no policies, `REVOKE ALL ... FROM PUBLIC, anon, authenticated`.
- Data-driven: check types, seasons, service modules, operating branches and work units come from the database. No hard-coded lists in the UI.
- Time zone `Pacific/Auckland`. Weekdays are ISO, Monday = 1. Solar offsets are hours in 0.25 steps between -12 and 12.
- A change never takes effect before approval. If its effective-from date has passed when approved, it takes effect on the approval date.
- Redefining an existing function: copy the body from the **latest migration that defines it** (else from `supabase/schema.sql`), change only what the task says.
- Migration tests use pre-migration fixtures inside the test, never function bodies read from `schema.sql`. Docker image literal: `'postgis/postgis:17-3.5'`. Register each new test in `test/manage-identity-vehicle-notes-migration.test.js` as `if (process.env.BOB_TEST_POSTGRES === '1') require('./<name>.test');`.
- UI follows `docs/BOB_ENTERPRISE_SAAS_UX_TRAINING.md`: loading, empty, error, permission, preview and success states for every surface. Plain NZ English copy.

## Review Focus

1. **Night window across midnight** (sunset − 0.5 h → sunrise + 0.5 h) on a shift that starts after midnight: officers expect the window still in progress, not tomorrow night's. Test in Task 6.
2. **Approval after the effective date has passed:** expect it to apply from the approval date and the preview/decision to say so. Test in Task 5.
3. **Officer retries a check after a lost response:** the same request id with the same payload returns the original receipt; the client must resend the stored payload, not a fresh GPS fix. Tests in Tasks 8 and 12.
4. **Sunrise/sunset chosen for an anchor with no coordinates:** expect a clear "draw the boundary first" message and nothing saved. Test in Task 5.
5. **Editing terms when stops are already in progress** (`on_scene`/`completed`): those stops are never rewritten; only pending stops on future shifts regenerate, and the preview lists blocked shifts. Test in Task 6.

---

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/20261117000100_zone_briefing_parity.sql` | Zone briefing columns, zone briefing RPC, zone fields in editor/officer reads |
| `supabase/migrations/20261117000200_organization_operating_settings.sql` | Org settings table + RPCs; static-post descendant rule |
| `supabase/migrations/20261117000300_patrol_catalogues.sql` | `patrol_check_types`, `place_service_seasons`, admin RPC |
| `supabase/migrations/20261117000400_solar_events.sql` | NOAA sunrise/sunset + anchor point |
| `supabase/migrations/20261117000500_place_service_terms.sql` | Versions, seeds, validation, draw, window, get/preview/save/decide, roll job |
| `supabase/migrations/20261117000600_generator_reads_terms.sql` | `shift_stops.required_checks`; generator uses terms in force |
| `supabase/migrations/20261117000700_place_static_posts.sql` | Add/end static post at the place |
| `supabase/migrations/20261117000800_patrol_stop_checks.sql` | Record checks; departure/completion gate; officer read |
| `test/<name>-migration.test.js` (one per migration) | Static + disposable PostgreSQL tests |
| `apps/web/src/lib/placeServices.ts` (+ `.test.ts`) | Types, RPC wrappers, pure helpers |
| `apps/web/src/components/placeServices/*` | Tab, cards, editor, static, checks admin, settings, responsibility dialogs |
| `apps/web/src/components/OperationalPlaceManager.tsx` | Briefing tab (site or zone) and the new tab |
| `apps/web/src/pages/ApprovalsActivityPage.tsx` | Approve/reject `place_service_change` |
| `apps/web/src/components/OfficerStopChecks.tsx`, `OfficerPatrolStops.tsx` | Web officer check list |
| `apps/mobile/src/components/OfficerStopChecks.tsx`, `OfficerStopPanel.tsx` | Mobile officer check list |

---

### Task 1: Zone briefing parity (A1)

**Files:**
- Create: `supabase/migrations/20261117000100_zone_briefing_parity.sql`
- Create: `test/zone-briefing-parity-migration.test.js`
- Modify: `apps/web/src/components/OperationalPlaceManager.tsx` (View type line 10; tabs ~437–441; site form/"No Site is linked" ~447–456)
- Modify: `supabase/functions/officer-shift-briefing/handler.ts` (~line 79, the `client_sites` read) and `handler_test.ts`
- Test: `apps/web/src/components/OperationalPlaceManager.guard.test.ts`

**Interfaces:**
- Produces: columns `location_zones.risk_level text CHECK (risk_level IN ('low','medium','high','critical'))`, `site_brief text`, `access_instructions text`, `hs_notes text`.
- Produces: `public.manage_crm_zone_briefing(p_zone_id uuid, p_expected_version integer, p_risk_level text, p_site_brief text, p_access_instructions text, p_hs_notes text) RETURNS jsonb` → `{zone_id, configuration_version}`; bumps `configuration_version`; raises `'Zone changed since you opened it; reload'` (ERRCODE 40001) on version mismatch; same admin rule as `manage_crm_zone`.
- Produces: `get_crm_operational_place_editor` zone objects gain `risk_level, site_brief, access_instructions, hs_notes, configuration_version`; `get_officer_patrol_stops` zone `place` returns the zone's `access_instructions`, `hs_notes`; `get_officer_static_post` zone `place` returns `risk_level, site_brief, access_instructions, hs_notes`.

- [ ] **Step 1: Write the failing migration test** `test/zone-briefing-parity-migration.test.js`
  - Static: migration adds the four columns with the risk CHECK; defines `manage_crm_zone_briefing`; `REVOKE ALL ON FUNCTION public.manage_crm_zone_briefing(uuid, integer, text, text, text, text) FROM PUBLIC, anon;`; no `DROP`.
  - PostgreSQL (`zone briefing round-trips for an admin`): fixture admin of provider org; `manage_crm_zone_briefing(zone, 1, 'high', 'Gate at north end', 'Code 1234 from office', 'Tidal flats')` → returns `configuration_version = 2`; a second call with `p_expected_version = 1` raises SQLSTATE `40001`; a non-admin raises `42501`; `risk_level = 'extreme'` raises the CHECK violation.
  - PostgreSQL (`officer stop read shows zone safety notes`): a `shift_stops` row on the zone → `get_officer_patrol_stops(shift)` → `place.hs_notes = 'Tidal flats'`, `place.kind = 'zone'`.
- [ ] **Step 2: Run** `BOB_TEST_POSTGRES=1 node --test test/zone-briefing-parity-migration.test.js` — Expected: FAIL (migration missing).
- [ ] **Step 3: Write the migration** — columns, RPC, and the three redefined reads (copy bodies; change only the zone branches).
- [ ] **Step 4: Run the test** — Expected: PASS.
- [ ] **Step 5: Edge function** — when `location.zone_id === place.id`, skip the `client_sites` read (`site` stays `null`) instead of failing; add a `handler_test.ts` case "zone post returns briefing without a site" asserting status 200 and `post.place.hs_notes` present. Run `deno test supabase/functions/officer-shift-briefing/` — Expected: PASS.
- [ ] **Step 6: UI test first** — in `OperationalPlaceManager.guard.test.ts` assert the source no longer contains `No Site is linked to this place`, contains the tab label `Briefing`, and calls `manage_crm_zone_briefing`.
- [ ] **Step 7: UI** — rename view `'site'` to `'briefing'`; the tab shows an anchor picker listing every site and zone (`Site · name` / `Area · name`), and the same four fields; saves with `manage_crm_site_profile` or `manage_crm_zone_briefing` by anchor kind. Empty state when the place has neither: "Add an area or a site to this place first." Run `npx vitest run src/components/OperationalPlaceManager` and `npx tsc --noEmit` in `apps/web` — Expected: PASS.
- [ ] **Step 8: Register the test, commit** — `feat(place): briefing for sites and zones alike`.

### Task 2: Organisation operating settings and the static-post branch rule (calls 0, 2)

**Files:**
- Create: `supabase/migrations/20261117000200_organization_operating_settings.sql`
- Create: `test/organization-operating-settings-migration.test.js`

**Interfaces:**
- Produces: table `public.organization_operating_settings(organization_id uuid PRIMARY KEY REFERENCES organizations(id), place_changes_need_second_approver boolean NOT NULL DEFAULT false, branches_may_set_up_static_posts boolean NOT NULL DEFAULT false, updated_by uuid, updated_at timestamptz NOT NULL DEFAULT clock_timestamp())`. RLS on; SELECT policy for `is_admin_for_org(organization_id)`; no write policies.
- Produces: `public.get_organization_operating_settings(p_organization_id uuid) RETURNS jsonb` → `{place_changes_need_second_approver, branches_may_set_up_static_posts, other_approver_available}`; absent row = both false. `other_approver_available` = an active user other than `auth.uid()` passes `can_approve_action(user, p_organization_id)`.
- Produces: `public.set_organization_operating_setting(p_client_request_id uuid, p_organization_id uuid, p_setting text, p_value boolean) RETURNS jsonb` — `p_setting IN ('place_changes_need_second_approver','branches_may_set_up_static_posts')`, admin of that org required, upsert, `audit_log` action `organization_operating_setting_change` with `{client_request_id, setting, from, to}`; replay by `client_request_id` returns the first result.
- Produces: `public.can_set_up_static_post(p_provider_organization_id uuid, p_operating_organization_id uuid) RETURNS boolean` (STABLE, SECURITY DEFINER) = operating = provider, or (provider's `branches_may_set_up_static_posts` and operating ∈ `get_descendant_organizations(provider)`), and `is_admin_for_org(operating)`.
- Modifies: `create_operating_roster_work_unit` static branch joins agreements where `public.can_set_up_static_post(agreement.provider_organization_id, p_operating_organization_id)` instead of `agreement.provider_organization_id = p_operating_organization_id`.

- [ ] **Step 1: Failing tests** — `settings default off`: fresh org → both false. `setting change is audited and idempotent`: set → audit row count 1; replay same request id → still 1. `non-admin cannot change settings` → 42501. `branch static post follows the setting`: branch admin calls `create_operating_roster_work_unit(branch, 'Gate post', 'static', 'static_guarding', NULL, <provider agreement location>, <module>, ...)` → raises `Active static guarding agreement location and module required` while off; succeeds after the provider sets `branches_may_set_up_static_posts = true`; an unrelated org still fails.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Write the migration.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Register, commit** — `feat(org): optional second approval and branch static-post settings`.

### Task 3: Check-type and season catalogues (A6, call 4)

**Files:**
- Create: `supabase/migrations/20261117000300_patrol_catalogues.sql`
- Create: `test/patrol-catalogues-migration.test.js`

**Interfaces:**
- Produces: `public.patrol_check_types(id uuid PK, organization_id uuid NULL REFERENCES organizations(id), check_key text NOT NULL CHECK (check_key ~ '^[a-z][a-z0-9_]{1,40}$'), label text NOT NULL, needs_photo boolean NOT NULL DEFAULT false, needs_note boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true, created_by uuid, created_at, updated_at)`; unique index on `(coalesce(organization_id,'00000000-0000-0000-0000-000000000000'::uuid), check_key)`. Global seed (organization_id NULL): `lock_up` "Lock-up", `unlock` "Unlock", `random_check` "Random check", `bed_down` "Bed-down", `welfare_check` "Welfare check", `gate_check` "Gate check", `key_pickup` "Key pickup", `key_return` "Key return". RLS: authenticated SELECT where `organization_id IS NULL OR user_can_operate_organization(organization_id) OR is_admin_for_org(organization_id)`.
- Produces: `public.place_service_seasons(season_key text PK, label text NOT NULL, months integer[] NOT NULL, sort_order integer NOT NULL)` seeded `summer` {12,1,2}, `autumn` {3,4,5}, `winter` {6,7,8}, `spring` {9,10,11}; authenticated SELECT.
- Produces: `public.manage_patrol_check_type(p_client_request_id uuid, p_action text, p_organization_id uuid, p_check_type_id uuid, p_label text, p_needs_photo boolean, p_needs_note boolean) RETURNS jsonb` — actions `create|update|deactivate`; org admin only; global rows are read-only (`'Default check types cannot be changed'`); create derives `check_key` from the label (lower, non-alnum → `_`, trimmed) and raises `'A check called % already exists'` on clash with a global or own key; audited `patrol_check_type_<action>`.
- Produces: `public.active_check_keys_for(p_organization_id uuid) RETURNS text[]` (STABLE) — active global + org keys.

- [ ] **Step 1: Failing tests** — seed has exactly the 8 global keys; org admin creates "Alarm panel check" → key `alarm_panel_check`; creating "Lock-up" → clash error; updating a global row → error; deactivate hides it from `active_check_keys_for`; another org cannot see the first org's type through RLS (set role `authenticated` with JWT sub).
- [ ] **Step 2: Run** — FAIL. **Step 3: Migration.** **Step 4: Run** — PASS.
- [ ] **Step 5: Register, commit** — `feat(patrol): check-type and season catalogues`.

### Task 4: Solar events (A7)

**Files:**
- Create: `supabase/migrations/20261117000400_solar_events.sql`
- Create: `test/solar-events-migration.test.js`

**Interfaces:**
- Produces: `public.solar_event_at(p_date date, p_lat double precision, p_lng double precision, p_event text) RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE` — NOAA general solar position algorithm, zenith 90.833°, `p_event IN ('sunrise','sunset')`; returns NULL when the sun does not rise or set that day; `p_date` is the local (Pacific/Auckland) calendar date.
- Produces: `public.place_anchor_point(p_site_id uuid, p_zone_id uuid) RETURNS geometry(Point,4326)` (STABLE, SECURITY DEFINER, internal) — site `center_point`, else zone `center_point`, else `ST_Centroid(boundary)` of the site/zone, else NULL.

- [ ] **Step 1: Failing tests** (within ±4 minutes, compared in `Pacific/Auckland`):
  - Wellington (-41.2865, 174.7762) 2026-12-21: sunrise 05:44, sunset 20:57.
  - Wellington 2026-06-21: sunrise 07:47, sunset 16:58.
  - Longyearbyen (78.22, 15.65) 2026-06-21 sunrise → NULL.
  - `place_anchor_point` falls back to the zone boundary centroid when `center_point` is NULL, and returns NULL with neither.
- [ ] **Step 2: Run** — FAIL. **Step 3: Migration.** **Step 4: Run** — PASS.
- [ ] **Step 5: Register, commit** — `feat(patrol): sunrise and sunset in the database`.

### Task 5: Versioned place service terms (A3, A5, A8, call 0, call 1)

**Files:**
- Create: `supabase/migrations/20261117000500_place_service_terms.sql`
- Create: `test/place-service-terms-migration.test.js`

**Interfaces:**
- Terms JSON (`p_terms`), validated and normalised server-side:
  ```json
  {"anchor":{"site_id":null,"zone_id":"uuid"},"module_key":"freedom_camping",
   "days":{"mode":"fixed","weekdays":[1,2,3,4,5]} | {"mode":"random","per_week":3,"allowed":[1,2,3,4,5,6,7]},
   "window":{"mode":"any"} | {"mode":"fixed","start":"22:00","end":"06:00"}
          | {"mode":"solar","start":{"anchor":"sunset","offset_hours":-0.5},"end":{"anchor":"sunrise","offset_hours":0.5}},
   "months":[],"visits_per_shift":1,"min_gap_minutes":60,"dwell_minutes":10,
   "checks":["gate_check","lock_up"],"officer_instructions":"..."}
  ```
  A solar endpoint `anchor` is `sunrise|sunset|clock`; `clock` carries `"time":"hh:mm"` and `offset_hours` 0. `months: []` means all.
- Produces: `public.place_service_term_versions(id uuid PK, organization_id uuid NOT NULL /* provider */, service_agreement_id uuid NOT NULL, location_id uuid NOT NULL, delivery_schedule_id uuid NULL, work_unit_id uuid NULL, service_kind text CHECK IN ('patrol','static_guarding'), change_kind text CHECK IN ('create','update','end'), effective_from date NOT NULL, applied_effective_from date NULL, terms jsonb NOT NULL, status text CHECK IN ('pending','approved','rejected') , reason text, requested_by uuid NOT NULL, requested_at timestamptz NOT NULL DEFAULT clock_timestamp(), client_request_id uuid NOT NULL UNIQUE, request_fingerprint text NOT NULL, decided_by uuid, decided_at timestamptz, decision_reason text, approval_action_id uuid)`. A trigger rejects DELETE and any UPDATE except `pending → approved|rejected` setting only `status, applied_effective_from, decided_by, decided_at, decision_reason, delivery_schedule_id, work_unit_id`. RLS SELECT for `is_admin_for_org(organization_id)`.
- Produces: `public.patrol_schedule_draw_seeds(delivery_schedule_id uuid PK REFERENCES service_agreement_delivery_schedules(id), seed bytea NOT NULL DEFAULT extensions.gen_random_bytes(32))` — RLS on, no policies, `REVOKE ALL FROM PUBLIC, anon, authenticated`.
- Produces (internal, service_role only):
  - `public.normalise_place_service_terms(p_agreement_id uuid, p_location_id uuid, p_terms jsonb) RETURNS jsonb` — raises with exactly these messages: `'Choose one place: a site or an area'`, `'That place is not part of this location'`, `'Choose an active service (module)'`, `'This service is not delivered as visits to a place'`, `'Choose at least one day of the week (Monday = 1)'`, `'Random days per week must be between 1 and the number of allowed days'`, `'Offsets must be in quarter hours between -12 and 12'`, `'Draw the boundary for this place before using sunrise or sunset times'`, `'Months must be between 1 and 12'`, `'Unknown or inactive check: %'`, plus the visits/gap/dwell ranges and messages copied from `manage_crm_agreement_delivery_schedule`.
  - `public.place_service_terms_at(p_delivery_schedule_id uuid, p_date date) RETURNS jsonb` — terms of the approved version with the latest `applied_effective_from <= p_date` (ties: latest `decided_at`); NULL if none or if that version is `end`.
  - `public.place_service_drawn_days(p_delivery_schedule_id uuid, p_date date, p_allowed integer[], p_per_week integer) RETURNS integer[]` — the ISO weekdays drawn for `p_date`'s ISO week: sort `p_allowed` by `extensions.hmac(isoyear||'-'||isoweek||'-'||day, seed, 'sha256')`, take `p_per_week`, return sorted.
  - `public.place_service_window_at(p_terms jsonb, p_date date, p_point geometry, p_shift_start timestamptz, p_shift_end timestamptz) RETURNS TABLE(window_open timestamptz, window_close timestamptz)` — `any` → NULLs; `fixed` → `patrol_window_bounds`; `solar` → each endpoint resolved via `solar_event_at` (+ offset) or the clock time; if close ≤ open add one day; apply the same "last night's window still running" shift as `patrol_window_bounds`.
  - `public.apply_place_service_version(p_version_id uuid) RETURNS jsonb` — for `patrol`: creates/updates the schedule + config in the shape `manage_crm_agreement_delivery_schedule` uses (module + agreement location upsert, toolset mapping), ensures a seed row, and when `applied_effective_from <= current_date` projects the terms onto the live columns (`active_days` = weekdays or allowed, `active_months`, `window_start/end` for fixed, `time_window_type` `'fixed'` or `'sunrise_sunset'`, `required_actions` = checks as jsonb array); `end` sets both rows inactive from that date (projected now if due). Regenerates pending stops on affected future shifts the way `save_location_patrol_setup` does.
- Produces (authenticated):
  - `public.get_place_services(p_location_id uuid) RETURNS jsonb` → `{location, anchors:[{kind,id,name,has_point}], agreements:[{id,provider_organization_id,name}], services:[{delivery_schedule_id, service_kind, module_key, anchor, terms, effective_from, pending:{version_id, effective_from, terms, requested_by_name}|null, responsibility:{work_unit_id,work_unit_name}|null, work_unit:{id,name,active}|null}], modules:[{module_key, toolset_key}], check_types:[{check_key,label,needs_photo,needs_note,is_global}], seasons:[{season_key,label,months}], operating_branches:[{id,name}], settings:<get_organization_operating_settings>, can_manage:boolean}`. Returns only agreements whose provider the caller administers; `can_manage=false` and empty lists otherwise.
  - `public.preview_place_service_change(p_location_id uuid, p_agreement_id uuid, p_delivery_schedule_id uuid, p_change_kind text, p_terms jsonb, p_effective_from date) RETURNS jsonb` → `{normalised_terms, applies_from, needs_approval, affected:[{shift_id,date,work_unit_name}], blocked:[{shift_id,reason}], next_days:[{date, patrols:boolean, window_open, window_close, covered:boolean}] /* 28 days */, warnings:[text], preview_fingerprint}`. `warnings` includes `'No rostered shift for the responsible run on <date>'` for drawn/active days without coverage (use the same coverage source as `preview_work_unit_coverage`). Fingerprint = md5 of actor, location, normalised terms, effective date, affected, blocked and the schedule's `patrol_route_stop_modules`.
  - `public.save_place_service_change(p_client_request_id uuid, p_location_id uuid, p_agreement_id uuid, p_delivery_schedule_id uuid, p_change_kind text, p_terms jsonb, p_effective_from date, p_reason text, p_preview_fingerprint text) RETURNS jsonb` → `{version_id, status:'approved'|'pending', applied_effective_from, delivery_schedule_id}`. Rejects `p_effective_from < current_date` with `'Effective from cannot be in the past'`; stale fingerprint → `'Place services changed; reload and confirm a fresh preview'` (40001). Replay with the same request id and same fingerprint returns the stored result with `replayed:true`; different payload → 42501. When the provider's `place_changes_need_second_approver` is on: insert the version `pending` and a `bob_agentic_actions` row (`organization_id`=provider, `user_id`=`triggered_by`=actor, `action_type`='place_service_change', `status`='pending', `proposed_payload`=`{version_id, location_id, change_kind, effective_from, terms}`, `context_table`='place_service_term_versions', `context_summary`=a one-line description). Otherwise insert `approved` with `applied_effective_from = p_effective_from` and call `apply_place_service_version`. Audit `place_service_change_<status>`.
  - `public.decide_place_service_change(p_client_request_id uuid, p_version_id uuid, p_decision text, p_reason text) RETURNS jsonb` — `p_decision IN ('approve','reject')`; caller ≠ requester (`'You cannot approve your own change'`); `can_approve_action(auth.uid(), provider)`; reject needs a reason. Approve sets `applied_effective_from = greatest(effective_from, current_date)`, applies it, sets the agentic action `applied` + `approved_by/approved_at`; reject sets `rejected` + `rejection_reason`. Static post approvals call Task 7's internal applier.
  - `public.roll_place_service_terms() RETURNS integer` (service_role) — projects versions whose `applied_effective_from = current_date` onto live columns; scheduled with `cron.schedule('place-service-terms-roll', '7 * * * *', 'SELECT public.roll_place_service_terms()')`.

- [ ] **Step 1: Failing tests** (fixture: provider org, admin A, admin B, client org, location with one zone that has a boundary and one zone without, live operational agreement, `module_catalog` rows, catalogues from Task 3, Task 4 functions):
  - `save without approval applies a dated version` → status `approved`; schedule + config exist; config `time_window_type = 'sunrise_sunset'` for a solar window; a second update writes a second version and the first row is unchanged.
  - `versions are immutable` → `UPDATE ... SET terms` and `DELETE` both raise.
  - `sunrise schedule on an anchor with no point is refused` → exact message; no version row.
  - `random draw is deterministic and within allowed days` → same week twice gives the same 3 days ⊂ allowed; across 10 weeks at least two different draws; `per_week = 8` refused.
  - `seed is not readable by authenticated` → `SET ROLE authenticated; SELECT * FROM patrol_schedule_draw_seeds` raises permission denied.
  - `second approval: pending until another admin approves` → setting on; A saves → `pending`, agentic action `pending`, no schedule change; A decides → `'You cannot approve your own change'`; B approves → `approved`.
  - `late approval applies from the approval date` → effective_from = today, approval run with `current_date` faked via a fixture-dated version (insert pending with effective_from yesterday through the fixture) → `applied_effective_from = current_date`.
  - `stale preview is rejected` → change a `patrol_route_stop_modules` row after preview → 40001.
  - `replay` → same request id + same payload returns `replayed:true`; changed payload → 42501.
  - `get_place_services hides agreements of other providers` → admin of an unrelated org sees `can_manage=false`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Migration.** **Step 4: Run** — PASS.
- [ ] **Step 5: Register, commit** — `feat(place): versioned patrol terms with optional second approval`.

### Task 6: Generator reads the terms in force (A3, A6, A7, A8, call 1)

**Files:**
- Create: `supabase/migrations/20261117000600_generator_reads_terms.sql`
- Create: `test/generator-reads-terms-migration.test.js`

**Interfaces:**
- Consumes: `place_service_terms_at`, `place_service_drawn_days`, `place_service_window_at`, `place_anchor_point`.
- Produces: column `shift_stops.required_checks text[] NOT NULL DEFAULT '{}'`.
- Modifies: `generate_shift_stops_internal(p_shift_id uuid, p_shift_date date, p_config_id uuid)` (copy from `20261116045308_location_patrol_responsibility.sql`): when the config has a `delivery_schedule_id` and `place_service_terms_at(...)` is not NULL, use those terms — day filter (fixed weekdays, or `ISODOW ∈ place_service_drawn_days(...)`), month filter, window via `place_service_window_at`, `visits_per_shift`/`min_gap`/`dwell`/instructions from terms, `required_checks` = terms `checks`. Otherwise keep the existing column-driven behaviour unchanged. Stops already `on_scene`/`completed` are never touched (existing rule).

- [ ] **Step 1: Failing tests:**
  - `solar night window crosses midnight` → terms sunset −0.5 h to sunrise +0.5 h at Wellington; shift 2026-12-21 20:00–2026-12-22 08:00 → stop `sla_window_open` ≈ 20:27 NZDT, `sla_arrive_by`/close ≈ 06:14 next day (±4 min).
  - `shift after midnight sees last night's window` → shift 2026-12-22 01:00–07:00 → window open on the 21st.
  - `random day not drawn produces no stop` → per_week 1; shift on an undrawn day → 0 stops; on the drawn day → stops.
  - `months filter` → months [6,7,8]; December shift → 0 stops.
  - `checks copied to stops` → `required_checks = '{gate_check,lock_up}'`.
  - `legacy configs unchanged` → a config without versions generates exactly as before (compare to fixture expectation from the #537 test).
  - `stops in progress are not regenerated` → an `on_scene` stop survives a terms update; preview lists the shift in `blocked`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Migration.** **Step 4: Run** — PASS. Also run `BOB_TEST_POSTGRES=1 node --test test/location-patrol-responsibility-migration.test.js` — Expected: PASS (no regression).
- [ ] **Step 5: Register, commit** — `feat(patrol): stops follow the terms in force on the shift date`.

### Task 7: Static guarding at the place (A4, calls 2, 3)

**Files:**
- Create: `supabase/migrations/20261117000700_place_static_posts.sql`
- Create: `test/place-static-posts-migration.test.js`

**Interfaces:**
- Consumes: `can_set_up_static_post`, `create_operating_roster_work_unit` (Task 2), `place_service_term_versions`.
- Produces: `public.add_place_static_post(p_client_request_id uuid, p_location_id uuid, p_agreement_id uuid, p_site_id uuid, p_zone_id uuid, p_post_name text, p_operating_organization_id uuid, p_required_skill_ids uuid[], p_reason text) RETURNS jsonb` → `{version_id, status, work_unit_id|null}`. Upserts the `static_guarding` agreement module and agreement location, writes a `static_guarding`/`create` version (`effective_from = current_date`), and when no approval is needed creates the unit via `create_operating_roster_work_unit(..., 'static', 'static_guarding', NULL, <location id>, <module id>, NULL, NULL, NULL)` then sets `required_skill_ids`/`required_skill_names` from `skills`. With approval on, the unit is created in `decide_place_service_change`.
- Produces: `public.end_place_static_post(p_client_request_id uuid, p_work_unit_id uuid, p_reason text) RETURNS jsonb` — writes an `end` version; when applied sets `roster_work_units.active = false`; existing slots/shifts stay.
- Produces (internal): `public.apply_place_static_post_version(p_version_id uuid) RETURNS uuid`.

- [ ] **Step 1: Failing tests:** provider admin adds a post on a **zone** → active static unit linked to the agreement location; branch admin refused while the setting is off and allowed when on; with approval on → no unit until B approves; end → unit inactive, existing roster slot still present, and creating a new slot on it raises (use the existing slot-creation RPC's inactive-unit error); replay returns the same unit.
- [ ] **Step 2: Run** — FAIL. **Step 3: Migration.** **Step 4: Run** — PASS.
- [ ] **Step 5: Register, commit** — `feat(place): add and end static guarding posts from the place`.

### Task 8: Officer checks on stops (A6, officer side)

**Files:**
- Create: `supabase/migrations/20261117000800_patrol_stop_checks.sql`
- Create: `test/patrol-stop-checks-migration.test.js`

**Interfaces:**
- Produces: `public.record_patrol_stop_check(p_request_id uuid, p_stop_id uuid, p_check_key text, p_outcome text, p_notes text, p_photo_path text, p_gps_lat double precision, p_gps_lng double precision, p_gps_accuracy_metres double precision) RETURNS jsonb` → `{action_id, check_key, outcome, performed_at, reference}`. Assigned officer of the shift only; stop must be `on_scene`; `p_check_key ∈ required_checks`; `p_outcome IN ('done','could_not_complete')`; `could_not_complete` needs notes (`'Say why the check could not be completed'`); `needs_note`/`needs_photo` from the check type enforced for `done`. Inserts `shift_stop_actions` with `action_type = p_check_key`, `outcome`, GPS, `client_request_id = p_request_id`, `evidence_metadata = {photo_path}`. Replay: same request id + identical payload returns the first receipt; different payload → `'Check request replay conflicts'` (42501). Recording a key twice keeps the latest by `performed_at`.
- Modifies: `manage_officer_patrol_stop` (`depart`) and `complete_shift_stop` raise `'Record every required check before leaving: %'` (missing labels, comma-separated) when any `required_checks` key lacks a recorded outcome.
- Modifies: `get_officer_patrol_stops` adds per stop `checks:[{check_key,label,needs_photo,needs_note,outcome|null,notes|null,performed_at|null}]` (copy from Task 1's version).

- [ ] **Step 1: Failing tests:** check on a pending stop refused; done check recorded and listed; could-not-complete without notes refused; departure blocked naming the missing check label, allowed once all have outcomes; a stop with no required checks departs as before; replay same payload → same `action_id`; replay with different GPS → 42501; another officer → 42501.
- [ ] **Step 2: Run** — FAIL. **Step 3: Migration.** **Step 4: Run** — PASS. Also rerun `test/checkpoint-operating-branch-migration.test.js` — PASS.
- [ ] **Step 5: Register, commit** — `feat(officer): record required checks at each stop`.

### Task 9: Web data layer (`placeServices.ts`)

**Files:**
- Create: `apps/web/src/lib/placeServices.ts`, `apps/web/src/lib/placeServices.test.ts`

**Interfaces:**
- Produces types mirroring Task 5: `PlaceServiceTerms`, `PlaceServicesWorkspace`, `PlaceServicePreview`, `PlaceServiceSaveResult`.
- Produces: `fetchPlaceServices(locationId: string): Promise<PlaceServicesWorkspace>`, `previewPlaceServiceChange(input: PlaceServiceChangeInput): Promise<PlaceServicePreview>`, `savePlaceServiceChange(input: PlaceServiceChangeInput & { requestId: string; reason: string; previewFingerprint: string }): Promise<PlaceServiceSaveResult>`, `decidePlaceServiceChange(versionId: string, decision: 'approve'|'reject', reason: string, requestId: string)`, `addStaticPost(...)`, `endStaticPost(...)`, `manageCheckType(...)`, `setOperatingSetting(...)` — each throws `Error` with the server message.
- Produces pure helpers: `monthsForSeasons(seasons: Season[], keys: string[]): number[]`, `describeTerms(terms: PlaceServiceTerms, labels: { checks: Record<string,string>; seasons: Season[] }): string`, `localTermsErrors(terms: PlaceServiceTerms, anchorHasPoint: boolean): string[]` (same messages as the server for days, random count, quarter-hour offsets, missing point).

- [ ] **Step 1: Failing tests:** `describeTerms` → `"Mon–Fri · 22:00–06:00 · 1 visit · Gate check, Lock-up"` for fixed; `"3 random days a week · sunset −0.5 h to sunrise +0.5 h · Jun–Aug"` for random/solar; `monthsForSeasons(seed, ['summer'])` → `[1,2,12]`; `localTermsErrors` returns `'Offsets must be in quarter hours between -12 and 12'` for 0.3 and the boundary message for solar without a point; `savePlaceServiceChange` passes `p_preview_fingerprint` and surfaces the server error text.
- [ ] **Step 2: Run** `npx vitest run src/lib/placeServices` — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; `npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** — `feat(web): place services data layer`.

### Task 10: Patrols & services tab and schedule editor (A2, A3, A5 UI)

**Files:**
- Create: `apps/web/src/components/placeServices/PlaceServicesTab.tsx`, `ServiceCard.tsx`, `PatrolScheduleEditor.tsx`, `PlaceServicesTab.css`, `PlaceServicesTab.test.tsx`
- Modify: `apps/web/src/components/OperationalPlaceManager.tsx` (add view `'services'` and tab "Patrols & services")

**Interfaces:**
- Consumes: Task 9.
- Produces: `<PlaceServicesTab locationId={string} />`.

Behaviour: cards per service (module label via the existing module label helper — find it with `grep -rn "moduleLabel\|MODULE_LABEL" apps/web/src/lib`), anchor `Site · name`/`Area · name`, work unit, `describeTerms`, checks, effective-from, a "Waiting for approval" badge with the proposed summary when `pending`. Actions: Add patrol, Add static guarding, Edit, End. Editor fields exactly as spec A3; window mode radio `Any time | Between times | Sunrise / sunset`; solar endpoints choose `Sunrise | Sunset | Clock time` and an offset stepper in 0.25 h; months grid with season shortcut chips from `workspace.seasons`; checks from `workspace.check_types`; effective-from date (min today). Submit = Preview (shows affected, blocked, 28-day calendar strip, warnings, "applies from" and "needs approval") then Confirm with a required reason. No agreement → explanation and a link to the client's CRM agreement page. `can_manage=false` → read-only cards and "You can view but not change this place's services."

- [ ] **Step 1: Failing tests** (`PlaceServicesTab.test.tsx`, mocked `supabase.rpc`): renders loading then cards; empty state "No patrols or services at this place yet."; zone-only place can add a patrol (anchor list has only areas); choosing a season ticks Dec, Jan, Feb; solar mode without a point shows the boundary message and disables Preview; Confirm sends the fingerprint from preview; server error text is shown in an alert; pending version shows "Waiting for approval".
- [ ] **Step 2: Run** `npx vitest run src/components/placeServices` — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; `npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** — `feat(web): patrols and services tab at the place`.

### Task 11: Static post, check types, settings and responsible run dialogs

**Files:**
- Create: `apps/web/src/components/placeServices/StaticPostDialog.tsx`, `CheckTypesDialog.tsx`, `PlaceSettingsPanel.tsx`, `ResponsibleRunDialog.tsx`, `placeServicesDialogs.test.tsx`
- Modify: `PlaceServicesTab.tsx` (wire the actions)

**Interfaces:**
- Consumes: Task 9 wrappers; #537 `get_location_patrol_setup(p_location_id)`, `preview_location_patrol_setup(p_location_id, p_changes)`, `save_location_patrol_setup(p_location_id, p_client_request_id, p_expected_version, p_preview_fingerprint, p_changes)`.

Behaviour:
- Static post: anchor, post name, operating branch (`workspace.operating_branches`), optional skills (existing skills source used by roster work units), reason. Success shows "Post created; roster it from the Roster" with a link to `/admin/roster`, or "Waiting for approval".
- Check types: list global (read-only, "Default") and own types; add, rename, deactivate.
- Settings panel (provider admins): two toggles with plain explanations. When second approval is on and `other_approver_available=false`, show "No other administrator can approve changes. Turn this off, or add an approver." with the off action.
- Responsible run (my call, see handoff): the patrol work unit is the #537 responsibility, so the card's "Responsible run" action opens this dialog: work unit from the #537 setup's run list, billing basis from `patrol_billing_units` with source "Agreement's standard rate" by default, effective-from, preview then save via #537 RPCs. A new patrol card with no run shows "No responsible run yet" and this action.

- [ ] **Step 1: Failing tests:** static post success message and link; branch selection lists only returned branches; default check types have no edit controls; settings warning appears with no other approver; responsible run sends `p_expected_version` and `p_preview_fingerprint` from the preview.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; typecheck PASS.
- [ ] **Step 5: Commit** — `feat(web): static posts, check types, settings and responsible run`.

### Task 12: Approvals and officer check lists

**Files:**
- Modify: `apps/web/src/pages/ApprovalsActivityPage.tsx` (+ its test)
- Create: `apps/web/src/components/OfficerStopChecks.tsx`, `OfficerStopChecks.test.tsx`; Modify: `OfficerPatrolStops.tsx`
- Create: `apps/mobile/src/components/OfficerStopChecks.tsx`; Modify: `apps/mobile/src/components/OfficerStopPanel.tsx`

**Interfaces:**
- Consumes: `decide_place_service_change`, `record_patrol_stop_check`, `get_officer_patrol_stops.checks`.
- Produces: `<OfficerStopChecks stop={stop} onRecorded={() => void} />` (web), same props on mobile.

Behaviour:
- Approvals: `action_type === 'place_service_change'` shows the proposed summary (`describeTerms`) and Approve / Reject (reason required) calling `decidePlaceServiceChange`; own requests show "Another administrator must approve this".
- Officer: while `on_scene`, list each check with Done / Couldn't complete (reason), note/photo when required (photo via the existing `OfficerPhotoAttachments` upload path, `OFFICER_PHOTO_BUCKET`). Each attempt stores `{requestId, payload}` per check in component state (mobile: in the offline package store) and retries resend the stored payload; a new attempt gets a new id only after success or a user edit. The Leaving button is disabled with "Record every check first" until all checks have outcomes. Mobile `OfficerStopPanel` shows the same list before `complete_shift_stop`; use `userFacingError` for messages.

- [ ] **Step 1: Failing tests:** approvals shows Approve for `place_service_change` and calls the RPC with the reason; web checks: Leaving disabled until all checks recorded; Couldn't complete requires a reason; a failed save retried sends the identical request id and GPS values (Review Focus 3).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** web vitest + `npx tsc --noEmit` (web) and the mobile typecheck (`npx tsc --noEmit` in `apps/mobile`) — PASS.
- [ ] **Step 5: Commit** — `feat(officer): check lists on stops and approval of place changes`.

### Task 13: Acceptance, review and release

**Files:** `apps/web/e2e/place-services.spec.ts` (new, offline fixtures)

- [ ] **Step 1: E2E** — with `E2E_OFFLINE=1`, mocked RPCs: open Operational setup for a zone-only place → Patrols & services → add a sunset–sunrise patrol with Gate check → preview → confirm → card shows the summary. Run `npx playwright test e2e/place-services.spec.ts` — PASS.
- [ ] **Step 2: Full local gates** — `npm test` (root), `BOB_TEST_POSTGRES=1 node --test test/manage-identity-vehicle-notes-migration.test.js`, `npx vitest run` and `npx tsc --noEmit` in `apps/web` — all PASS.
- [ ] **Step 3: Reviews** — run the `canon-conformance-reviewer` and `ux-states-reviewer` agents on the branch diff; fix confirmed findings.
- [ ] **Step 4: PR** — push `feat/place-services-schedule-20261116`, open the PR, wait for CI and the Copilot review, address findings, merge with `gh pr merge <n> --rebase`.
- [ ] **Step 5: Release** — governed release (migrations on live, catalog snapshot PR, `node scripts/atlas-refresh.js --apply`, Vercel). Verify live: `get_place_services` for Rabbit Island (TDC) returns its three zones as anchors; `patrol_check_types` has 8 global rows; `cron.job` has `place-service-terms-roll`.
