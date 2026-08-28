# UI Baseline

Status: rebuild specification
Source: Bob's read-only, verified findings from the original GitLab repository (project ID 83317421, ref `Main`) via `bob-repo-search` — NOT this GitHub repo, which has never contained a frontend. See [historical-sources.md](historical-sources.md) for the open question of whether this GitLab ref matches what is actually live on Vercel.
Last reviewed: 2026-08-28

## Purpose

This document is the build specification for the new Field Compliance Manager frontend. We do not have write access to the original GitLab repository, so defects and gaps found there are not "reported back" — they are requirements this rebuild must NOT repeat. Every verified behavior, data contract, route, and permission boundary recorded here is what the new implementation must reproduce faithfully; every defect recorded here is what the new implementation must fix instead of copy.

The baseline is intentionally split into verified facts, provisional findings, and open evidence. Items marked unknown must not be presented as settled product behavior, and must not be guessed at during implementation — they must be resolved from further Bob evidence first.

## Product UI principles

## File read coverage status (repo_search)

- `apps/web/src/pages/AdminHubPage.tsx` (599 lines): accumulated read coverage is complete to end-of-file. Findings recorded below and in the Admin Hub sections are treated as verified except where a window was dropped/truncated in transit — those tails are explicitly excluded from verified evidence rather than assumed.
- `apps/web/src/shells/AdminShell.tsx` (810 lines): accumulated read coverage is complete to end-of-file, same caveat for truncated-in-transit windows.
- `apps/web/src/routing/RoleRouter.tsx`: fully read in one clean sequential window (no truncation) and is treated as complete verified evidence, including the `PortalSelector` sub-component and its inline styles.
- Neither `AdminHubPage.tsx` nor `AdminShell.tsx` should be re-requested in full; further work on them should target specific symbols/behaviors not yet traced (e.g. `NAV_GROUPS`/`MOBILE_NAV` full definitions, `getBobContext` callers) rather than re-reading line ranges already covered.
- Remaining open frontend target: the shared API/Supabase client (`apps/web/src/lib/supabase.ts` — already spot-read once, treat as read for the client singleton itself, but `apps/web/src/lib/env.ts` it imports is not yet verified) for the dependency map.

### Explicit gap: Officer/Scan/Client shells

`RoleRouter.tsx` proves that `officer`, `scan_operator`, and `client_*` roles are routed to `OfficerShell`, `ScanShell`, and `ClientShell` respectively.

- `apps/web/src/shells/OfficerShell.tsx` (975 lines): Bob reports this was read to end-of-file, but per the same discipline used for `AdminHubPage.tsx`/`AdminShell.tsx`, only windows actually shown in this conversation are treated as verified evidence — a file-level "read to line N" claim on its own is not. See the verified findings below for what has genuinely been confirmed from this file so far; the remainder (imports, hooks, full component list, module-gating source, Supabase/API calls) is still open.
- `apps/web/src/shells/ScanShell.tsx` — not yet read at all, including how it differs given it has no dynamic route segment.
- `apps/web/src/shells/ClientShell.tsx` — not yet read at all, including its internal nested routing under the `/client/*` wildcard.

Next read: the child components/hooks `OfficerShell.tsx` imports near its top (per Bob's own recommendation), to ground the audit in actual dependencies rather than re-summarizing a file already marked complete.

## P0 SAFETY-CRITICAL: welfare check-in / SOS has no confirmed-delivery guarantee

`apps/web/src/hooks/useWelfareCheckin.ts` (179 lines, fully read) implements officer welfare escalation: `ok` → `due` (≤5 min remaining) → `overdue` (0 min remaining) → `man_down` (a full second interval elapsed past deadline) → `sos` (latched — once set, `tick()` refuses to overwrite it: `if (prev === 'sos') return 'sos'`). This is the most safety-critical code path found in the audit so far and ranks above every other finding, including the NOC telemetry issue.

Verified gaps:

- `triggerSOS()` inserts into `welfare_alerts` with a plain `await supabase.from(...).insert(...)` — the returned `{ error }` is never checked. If the insert fails (network loss, RLS denial, outage), the UI still sets local `status` to `'sos'` and reports success to the officer, who has no indication the alert never reached a supervisor. This is the same "silent zero" pattern found elsewhere in the codebase (`AdminHubPage` KPI/trend loaders), but here it can mean a genuine emergency alert appears sent when it was not.
- `checkIn()` has the identical unchecked-error pattern for both the `welfare_checks` insert and the `officer_welfare_settings` upsert.
- Supervisor escalation alerts use `void emitMissedAlert(...)` — `void` only suppresses the "unused promise" lint signal, it does not attach a `.catch`. A rejected promise here becomes an unhandled rejection: no retry, no user-facing failure state, no confirmation the supervisor was actually notified.
- No visible mechanism in this hook for a supervisor-side SOS clear to reach the officer's device. Once `status` latches to `'sos'`, the only path shown back to `'ok'` is the officer's own `checkIn()`. If clearing is meant to happen from a supervisor console, this hook would need to subscribe to or poll for that state change — not present here. Flag as an open question, not yet resolved either way.
- `lastCheckin ?? new Date()` as the tick anchor means: if `lastCheckin` is `null` because it failed to load (vs. genuinely never having checked in), the officer is shown a fresh full countdown rather than an unknown/unavailable state — the same load-failure-vs-empty-state ambiguity flagged for `AdminShell`'s module gating.

### Required rebuild behavior

1. Every write in the welfare/SOS path (`welfare_checks`, `welfare_alerts`, `officer_welfare_settings`) must check its `{ error }` and surface a distinct, visible "not confirmed — retry" state to the officer. A tap on SOS must never silently appear successful.
2. `emitMissedAlert` (and any other fire-and-forget escalation call) must have an explicit `.catch`/retry path, not bare `void`.
3. Resolve the open question on supervisor-side SOS clearing before implementation — do not guess at a mechanism.
4. Distinguish "no prior check-in" from "check-in state failed to load" explicitly; do not default a load failure to a fresh safe countdown.

**Implemented**: `apps/web/src/hooks/useOfficerSafety.ts` replaces the original two independent, uncoordinated hooks with one shared safety-state model. Every write (`checkIn`, `triggerSOS`, `acknowledgeAlert`) checks `{ error }` and surfaces failure via `writeStatus`/`lastError` rather than appearing to succeed silently. Movement (`recordMovement`) is evidence-only and can never clear `activeAlert` — only an explicit officer action (`checkIn` or `acknowledgeAlert`) can, satisfying the P0 auto-resolve fix above. `detectionState` exposes `active`/`disabled_by_org`/`disabled_by_officer`/`unknown` in plain terms (Bob's UX item 6), with matching text in `apps/web/src/lib/safetyStatusMessage.ts` (items 6-7, including explicit "cleared because you checked in" / "you acknowledged" wording so a resolved alert never looks like it vanished arbitrarily). Server-owned escalation timing and the duplicate-fire guard are both preserved exactly as required. 9 focused tests in `useOfficerSafety.test.tsx` plus 3 in `safetyStatusMessage.test.ts` cover: movement-never-resolves, acknowledge success/failure, SOS write failure, check-in error on either write, check-in-as-valid-acknowledgement, detection-state for every case, and the duplicate-fire guard. The open question on supervisor-side SOS/alert clearing (item 3 above) remains unresolved and is not guessed at in this implementation — `acknowledgeAlert` only covers the officer-initiated path.

**Resolved**: `useInactivityDetection.ts` (lines 121-193, end-of-file) has now been read in full. It confirmed the exact same P0 defect class: `recordGPSUpdate` auto-resolves an active `gps_lost`/`inactivity` episode on movement, and separately auto-clears a `gps_lost` episode on ANY fresh fix even without movement ("A fresh fix clears an active gps_lost episode even without movement"). `useOfficerSafety.ts` now unifies all three original hooks: `AlertKind` gained `'inactivity'` and `'gps_lost'`, both fixed the same way — a GPS fix (`recordMovement`) is evidence-only and can never clear `activeAlert`, only `checkIn`/`acknowledgeAlert` can. `gps_lost` fires when no fix at all has arrived within `inactivityMinutes` of the last one received (matching the original's own "measured from last fix, not from mount" semantics — it does not fire before any fix has ever arrived, same as the original); `inactivity` fires when fixes keep arriving but show no real movement. This also caught and fixed a latent bug in our own rebuild: `MOVEMENT_THRESHOLD_M` was declared but never actually used in `recordMovement`, so any GPS fix — not just genuine movement — was resetting the stationary timer; `recordMovement` now gates on real haversine distance, matching the original's own (correct) logic for this part. 3 new tests added (`useOfficerSafety.test.tsx`, now 12 total) cover `gps_lost` firing, `inactivity` firing distinctly from `gps_lost`, and the movement-threshold gating fix.

**Open, deliberately not resolved by guessing**: whether `motion` (man-down, GPS-stationary) and `inactivity` are meant to be genuinely distinct product signals with independently meaningful thresholds, or are an unintentional duplication in the original product — both are preserved as separate `AlertKind` values pending product-owner input rather than silently merged.

### Verified OfficerShell.tsx findings (from windows actually shown)

- The module-selection screen shows an explicit user-facing note: "Only modules granted by your administrator are shown." This is a real pattern the Admin side lacks — recall the P1 "silent module-gate fallback" finding for `AdminShell`/`AdminHubPage`, where a disabled page falls back to the hub with no explanation. The rebuild should give Admin the same honesty the Officer side already has, not the other way around.
- `ModulePortal` is a shared wrapper: a "← Home" back button, module icon/title, optional zone name, module content, and a persistent `ReportButton` FAB shown only for genuine field modules (excluded for `report`, `leave`, `timesheet`, `schedule`, `overnight_verification`, `checkpoint_scan` self-service screens). This back+FAB pattern is worth preserving as-is.
- `ShiftCard` formats shift date/time explicitly in `Pacific/Auckland` (hard-coded IANA timezone, `en-NZ` locale) via `toLocaleDateString`/`toLocaleTimeString`. This is a legitimate regional business constant (not fabricated data like the NOC telemetry), but it is a hard dependency on NZ-only operation that should be called out explicitly in the rebuild rather than silently baked in again — confirm whether this should become a configured constant if multi-region support is ever a goal.

Do not assume `ScanShell`/`ClientShell` mirror `AdminShell`'s or `OfficerShell`'s structure just because the routing pattern looks similar — neither has been opened yet.

## Verified OfficerShell.tsx head content (lines 1-120)

`OfficerShell.tsx` cites a *different* source-of-truth document than the Admin side: `docs/PRODUCT_DESIGN.md` §3.1, §4 — versus `docs/INSTRUCTION_MANUAL.md` §4.1/§2.3 for `AdminShell`/`RoleRouter`. Neither document has actually been read yet; every "source of truth" comment cited across the audit so far has been treated as a pointer, not verified content. Both should be read before finalizing any rebuild decision that claims to follow them.

Confirmed structure:

- Four officer entry states: **welfare standby** (no active/upcoming shift, no direct module access), **officer home** (has a shift, roster-first landing), **module selector** (admin granted multiple direct modules), **module portal** (inside one module). Note this is a *shift-gated* authorization axis distinct from Admin's module-gated axis — officer module access depends on active shift state, not just permission grants.
- Persistent chrome on every officer screen: `FieldSafetyBar` (top) and `PttBar` (bottom). **Corrected**: PTT was NOT built out for this app. The user clarified `ptt-server/` (present in this repo as a `dist/`-only skeleton, `package.json` name `fcm-ptt-server`, a `ws`-based stub with no source checked in) is leftover/prototype infrastructure carried over from an older, unrelated "FreedomCamping" app — not a live, wired feature of Field Compliance Manager. Do not assume `PttBar` actually connects to it; treat PTT as out of scope for this rebuild's safety audit entirely unless separately instructed otherwise. The earlier note in this doc speculating that `PttBar` was "very likely" wired to `ptt-server/` was an unverified assumption and is retracted.
- Hooks: `useWelfareCheckin` (verified), `useManDownDetection` (NOT yet read — see open question below), `useInactivityDetection` (not yet read), `useActiveShift` (not yet read), `useEnabledModules` (not yet read — see open question below).

### Confirmed from `OfficerShell.tsx` lines 80-240: exact org-gating fail-open source, a good visual pattern to preserve, and shell-level GPS facts

- **Org module gating, confirmed at the exact source line** (corroborates the `useEnabledModules` fail-open finding above with the real call site, not inference):
  ```ts
  const { enabled: orgModules, configured: orgConfigured } = useEnabledModules();
  const moduleAccess: string[] = orgConfigured
    ? grantedModules.filter((m) => orgModules.has(canonicalModuleKey(m)))
    : grantedModules;
  ```
  When `orgConfigured` is `false` — which the original hook returns for a transient read error just as much as for a genuinely unconfigured org — `moduleAccess` becomes the full unfiltered `grantedModules` list. This is the precise fail-open code path already fixed in this rebuild's `useEnabledModules.ts`/`isModuleEnabled`.
- **A good pattern worth preserving**: `OfficerShell` defines `WELFARE_BG`/`WELFARE_DOT`/`WELFARE_COLOUR` keyed by a five-value `WelfareStatus` (`ok`/`due`/`overdue`/`man_down`/`sos`) that visually distinguishes man-down (`'!!'`) from SOS (`'SOS'`) as separate labels, even though both currently share the same background/colour. This is more granular than this rebuild's `SafetyStatus` (`'ok'|'due'|'overdue'|'alerting'`), which folds man-down and SOS into one `'alerting'` value and relies on `activeAlert.kind` (`'sos'|'timeout'|'motion'`) to carry the distinction. **Rebuild requirement**: when a status-badge/indicator component is built (not yet built), it must render `activeAlert.kind` into a distinct label the same way the original does — never present a man-down and an SOS as the same generic "alert" text.
- **`GPS_HEARTBEAT_MS = 2 * 60 * 1000`** — the shell enforces a minimum 2-minute gap between `officer_gps_log` heartbeat writes. Record this as the confirmed real-world cadence for whenever a GPS-writing hook is rebuilt; do not invent a different interval.
- **Single shared GPS watcher at shell level**: `OfficerShell` holds one `gps` state from a single watcher and shares it with `FieldSafetyBar` (man-down detection + armed banner) rather than each module/component running its own watcher. This is a reasonable architecture to preserve — one source of truth for the officer's own live position, not duplicated watchers.
- `OFFICER_MODULE_TO_CANONICAL` remaps officer-facing module keys to canonical `organization_modules` keys where they differ (e.g. `parking` → `parking_enforcement`, `smoke_control` → `smoke_complaints`, `site_guard` → `static_guarding`), citing `packages/shared/src/modules.ts` as the canonical source (also not yet read). This is the same kind of multi-structure-must-stay-synchronized risk already flagged for `AdminShell`'s `VALID_ADMIN_PAGES`/`LEGACY_REDIRECTS` pair — here it's `ActiveModule`/`VALID_OFFICER_MODULES`/`MODULE_META`/`OFFICER_MODULE_TO_CANONICAL`/canonical shared modules, all needing to agree.

### Resolved: `useManDownDetection.ts` is a separate trigger, not duplicate logic — but shares no state with `useWelfareCheckin`

Confirmed: `useManDownDetection` is a distinct, GPS-motion-based detector (`fireManDownAlert` fires when no movement is detected for `stationaryMinutes`), independent from `useWelfareCheckin`'s time-based missed-check-in detector. Both are legitimate, complementary signals for the same underlying safety condition — this is not code duplication.

The real gap: **the two hooks maintain fully independent local React state with no shared source of truth**, while both write toward `welfare_alerts`. Concretely:

- `useWelfareCheckin`'s `status` (`ok`/`due`/`overdue`/`man_down`/`sos`) and `useManDownDetection`'s `manDownState.isActive` are two separate state machines that can each independently reach an "alerting" condition for the same officer, with neither aware of the other.
- `resolveManDownAlert()` only resets `useManDownDetection`'s own local state; it does not touch `useWelfareCheckin`'s `status`, and `useWelfareCheckin.checkIn()` (the only reset path shown for its own state) does not touch `useManDownDetection`'s state either.
- The rebuild must unify these into one shared safety-state model (or explicitly document why they must stay separate) so a supervisor clearing one alert type can't leave the officer's device showing a contradictory safety state from the other detector.

Full verified state/data inventory for this hook: `officerId`/`organizationId` gate every write; `enabled` (prop) and `settingsEnabled` (loaded) are two separate on/off switches; `stationaryMinutes`/`stationaryMs` is the no-movement threshold; `escalationMinutes` is loaded/retained for display only; `lastMovementRef` tracks the last meaningful-movement timestamp/coordinates; `lastPositionRef` holds the latest GPS fix used in the fired alert's payload; `manDownState`/`manDownStateRef` track active/alert-id/triggered-time; settings are read from `officer_welfare_settings` (`man_down_enabled`, `man_down_stationary_minutes`, `man_down_escalation_minutes`); resolution writes `status`/`resolved_by`/`resolved_at`/`resolution_notes` to `welfare_alerts`; the fire write sets `alert_type='man_down'`, `status='pending'`, `escalation_level=1`, GPS, and timestamps.

Also verified: `escalationMinutes` is intentionally loaded for settings/display only and explicitly **not** used for client-side escalation writes — the code comment states the server-side tick owns escalation timing. This is a correct, deliberate client/server separation of concerns and should be preserved as-is in the rebuild. Duplicate firing is also correctly guarded via `manDownStateRef.current.isActive` plus a running flag in the interval loop.

### Resolved: `useInactivityDetection.ts` is a THIRD independent welfare-alert writer, now read in full and folded into the rebuild

First surfaced by querying this repo's own `bob_capability_map`/`bob_app_map_edges` tables directly (the live Atlas data, not a Bob GitLab read), then confirmed via a full read of `apps/web/src/hooks/useInactivityDetection.ts` (lines 121-193, end-of-file):

- **Writes** to `welfare_alerts` and **references** `welfare_alerts.last_activity_at`, `welfare_alerts.notes`, `welfare_alerts.resolution_notes`, `welfare_alerts.escalation_level`, `welfare_alerts.resolved_by`, `welfare_alerts.status` — the exact same column set `useManDownDetection.ts` touches.
- **Reads** `officer_welfare_settings` — the same settings table both other hooks read.
- Fires two distinct alert kinds: `gps_lost` (no fix at all within the threshold) and `inactivity` (fixes arriving, but no movement within the threshold) — `gps_lost` takes priority when both conditions are true.
- **Same P0 defect confirmed at the source level**: `recordGPSUpdate` clears an active episode on movement, and separately clears a `gps_lost` episode on ANY fresh fix even without movement — neither requires acknowledgement, exactly mirroring the man-down defect.
- Also confirmed via Atlas: `components/PreArrivalDossier.tsx` reads and references `welfare_alerts`/`welfare_alerts.status` — a third consumer of alert state beyond the hooks and `WelfareAlertsPage.tsx`.

### Resolved: `useManDownDetection.guard.test.ts`, read in full — confirms the resolve-on-movement defect was an oversight, not a tested tradeoff

The guard test is a **source-text guard, not a behavioural test**. It exists to protect exactly one boundary: escalation timing (L1→L2→L3) stays server-authoritative — the client may set `escalation_level: 1` on the initial insert only, must never `.update()` `escalation_level`/`escalated_at`, and must still contain the resolve path and `haversineMetres`/`MOVEMENT_THRESHOLD_M`. It says nothing whatsoever about resolve-on-movement. This is meaningful: if the original team had deliberately accepted movement-based auto-resolve as a considered tradeoff, a "guard" test file protecting the hook's safety-relevant invariants would be the natural place to encode that — and it doesn't. This corroborates (does not prove, but supports) that the P0 defect was an oversight rather than an intentional, tested design decision.

**Implemented**: `apps/web/src/hooks/useOfficerSafety.guard.test.ts` mirrors this exact pattern against the rebuild — source-text guards (not behavioural) confirming: `escalation_level` is referenced exactly once (the initial insert), `escalated_at` is never referenced at all, `haversineMetres`/`MOVEMENT_THRESHOLD_M` are still present, and — going further than the original guard's scope — `recordMovement` never calls `setActiveAlert` or touches Supabase, and every `setActiveAlert(null)` call site is inside `checkIn` or `acknowledgeAlert` only. This locks the P0 fix in at the source level, not just via behavioural tests, so a future edit can't silently reintroduce movement-based resolution without a guard test failing immediately.

**Implemented**: `useOfficerSafety.ts` now unifies all three original hooks. See the "Implemented"/"Resolved" note under the P0 section immediately below for the exact fix and test coverage.

### Open, important: `welfare_alerts.acknowledged_by` is a SEPARATE column from `resolved_by` — our rebuild may be conflating two distinct actions

A schema search surfaced `welfare_alerts_acknowledged_by_fkey | welfare_alerts.acknowledged_by | user_profiles.id` in `docs/db/LIVE_SCHEMA.md`, alongside the already-known `resolved_by`. `WelfareAlertsPage.tsx` (not yet read in full) shows a branch `if (kind === 'acknowledge') { ... } else { ... }`, which strongly suggests the original product distinguishes **two separate actions**: acknowledging an alert (someone has seen it / is responding, without necessarily declaring the officer safe) and resolving it (confirming the officer is safe / closing it out).

**This rebuild's `acknowledgeAlert()` currently only implements one action** — it sets `status: 'resolved'`, `resolved_by`, `resolved_at` — i.e. it behaves like a "resolve," not a distinct "acknowledge." If the original genuinely has a two-step model (acknowledge without resolving, then separately resolve), this rebuild is missing a state: a supervisor should be able to say "I've seen this and am responding" without that being indistinguishable from "the officer is confirmed safe." Conflating these could mean an alert looks fully closed the moment anyone taps anything, even if the officer is still in danger and someone is merely en route.

**Also surfaced**: `docs/WELFARE_MODULE_INVESTIGATION.md`, which appears to already contain a product-owner-level assessment of the welfare module's gaps (one visible line: "build has only a thin countdown-timer welfare hook... GPS, metadata. Basis for GPS-inactivity detection"). Also `docs/APP_AUDIT_2026-07.md` (an existing colour-coded page-by-page audit, welfare rated 🟢/🟢/🟠/🟢/🟢) and `docs/REBUILD_TODO.md` (the original team's own rebuild backlog, already mentioning `officer_welfare_settings`). These may already document known gaps faster than further raw source tracing.

**Do not guess at the fix.** Before changing `acknowledgeAlert()`'s behavior or adding a separate `acknowledge()` action to `useOfficerSafety.ts`, this needs source evidence, not inference from a column name and one conditional branch.

**Next Bob reads, in order**:
1. `docs/WELFARE_MODULE_INVESTIGATION.md` in full — likely the fastest path to understanding what the product team already knows is wrong/incomplete about welfare.
2. `apps/web/src/pages/WelfareAlertsPage.tsx` in full, specifically the `kind === 'acknowledge'` branch and whatever the other branch does, to confirm the two-action model and exactly what each writes (`acknowledged_by`/`acknowledged_at` vs `resolved_by`/`resolved_at`).
3. The full `welfare_alerts` column list from `docs/db/LIVE_SCHEMA.md` (we have only fragments via grep) to confirm whether `acknowledged_at` also exists alongside `acknowledged_by`.
4. `docs/APP_AUDIT_2026-07.md`'s welfare section in full, and `docs/REBUILD_TODO.md`'s welfare-related items, as corroborating/prioritizing context.

## P0 SAFETY-CRITICAL: man-down alert auto-resolves on movement alone, with no positive human acknowledgement

This is the single highest-risk finding in the audit so far, ranking above the SOS confirmed-delivery gap. Movement above `MOVEMENT_THRESHOLD_M` updates `lastMovementRef` and **automatically resolves an active man-down alert** — there is no acknowledgement step, no server-side policy check, and no distinction between "officer is fine and moving normally" and "officer's device moved for an unrelated reason while the officer is still in danger" (dropped, kicked, carried, thrown, taken by someone else, etc.). A distressed officer's own struggling movement, or someone else moving the device, is enough to silently clear a live safety alert.

Secondary, lower-severity gaps confirmed in the same hook:

- `resolveManDownAlert()`'s error check (`if (error) return;`) correctly prevents local state corruption on failure (state is not falsely cleared), but gives **no visible feedback** to the officer or supervisor that the resolve attempt failed — from the user's perspective, tapping resolve can silently do nothing.
- The `officer_welfare_settings` load has no visible error branch — if that read fails, the hook silently continues on seeded/default values rather than surfacing an unknown-configuration state.

### Required rebuild behavior

1. Movement alone must never be sufficient to resolve a man-down alert. Require an explicit positive acknowledgement action from the officer (or a policy-backed server-side check), and treat movement as, at most, evidence that downgrades severity — not a resolution.
2. A failed resolve attempt must surface a visible local warning/retry state, not silently no-op.
3. A failed settings load must be represented as an unknown/unavailable configuration state, not silently fall through to defaults.
4. Keep the server-owned escalation timing exactly as-is — that separation is correct and should not be changed.

**Implemented**: `apps/web/src/hooks/useOfficerSafety.ts` — `recordMovement()` only updates evidence (position/last-movement timestamp) and never calls anything that clears `activeAlert`; only `acknowledgeAlert()` or `checkIn()` can, and both are explicit officer actions with checked writes. See the full implementation note under "Required rebuild behavior" below the welfare check-in section.

**Resolved (source confirmed, lines 161-230 of 230, end-of-file window)**: the exact defect is in `recordGPSUpdate`, not a separate call site — there is no other invocation to trace. The source shows:

```ts
if (moved >= MOVEMENT_THRESHOLD_M) {
  lastMovementRef.current = { lat, lng, at: now };
  // Movement clears an active man-down.
  if (manDownStateRef.current.isActive && manDownStateRef.current.alertId) {
    void resolveManDownAlert(manDownStateRef.current.alertId);
  }
}
```

This confirms, at the source line level, that GPS movement alone — with no officer acknowledgement and no server-side policy check — is sufficient to clear a live man-down alert; the comment ("Movement clears an active man-down.") shows this was the intended design, not an accidental bug. The hook does separately expose an explicit `resolveManDown(alertId?)` in its return value, so a genuine officer-initiated resolution path already exists in the original UI somewhere — the defect is specifically that movement *also* triggers the same resolution automatically, making the explicit path redundant rather than authoritative. `useOfficerSafety.ts` already fixes this correctly: `recordMovement()` has no call to anything that can clear `activeAlert`, full stop. No further tracing or additional fix is required for this finding.

### Resolved: `useEnabledModules.ts` has the exact same fail-open ambiguity as `AdminShell` — confirmed live in `OfficerShell`, not just theoretical

Confirmed: `useEnabledModules` is the one shared hook used by both `AdminShell` and `OfficerShell` for module gating (a genuine consistency win — no drift between the two shells' gating logic). But it collapses three distinct states into one fail-open outcome: a transient query error, zero rows loaded yet, and a genuinely unconfigured organization all currently resolve to the same `configured: false` / "show everything" behavior. This is exactly the tri-state defect already recorded as a P1 issue for `AdminShell`, now confirmed to originate from this one shared hook rather than being duplicated per-shell — and confirmed as **live behavior in `OfficerShell`**, not a theoretical risk: when `orgConfigured` is false, `OfficerShell` shows all granted modules regardless of whether that `false` came from a real read failure or genuine absence of configuration.

Concrete named example: Welfare Monitoring is available platform-wide but is **not enabled for this organization**. If any welfare-related surface reuses this same gating pattern, a read failure or unconfigured state could present safety-related UI that the organization never actually entitled — the opposite of the intended safety posture.

### Required rebuild behavior for `useEnabledModules`

1. Fixing this single hook fixes module-gating consistency for both `AdminShell` and `OfficerShell` at once — do not patch each shell independently.
2. Expose four distinct states explicitly: `loading`, `error`, `unconfigured` (confirmed zero rows exist for this org), `configured` (rows loaded).
3. Non-critical UI discovery may still choose to fail open on `unconfigured` if that is a deliberate rollout decision, but `loading` and `error` must never be treated as authorization to show a gated feature.
4. Any safety-relevant or write-capable module (welfare/man-down included) must default to fail-closed until entitlement is positively confirmed as `configured`.

**Implemented**: `apps/web/src/hooks/useEnabledModules.ts` exposes exactly these four states plus an `isModuleEnabled(key, { safetyRelevant })` helper matching requirements 3-4, with tests covering error/unconfigured/configured-disabled/configured-enabled in `useEnabledModules.test.tsx`.

## Bob's UX presentation review (state communication, not a new defect class)

Bob's review of the `useEnabledModules`-driven UI surface identified nine presentation-layer requirements that sit on top of the four-state hook contract above. These are refinements to how state is communicated, not new categories of defect:

1. **Distinct visible outcomes** for loading, read failure, and not-configured — they must not collapse into the same message/appearance.
2. **Safety-closed presentation**: for welfare/safety-sensitive surfaces, say the feature is unavailable because configuration could not be verified — never silently hide it *or* silently show it.
3. **Hidden vs. unavailable wording**: a module that exists platform-wide but isn't enabled for this org must say "not enabled for this organisation" — not "missing" or "broken."
4. **Shell consistency**: the same gating language/behavior must appear everywhere modules are surfaced (Admin and Officer must not draw different conclusions from the same backend state) — satisfied structurally by using one shared hook/message source, not per-shell copies.
5. **Action-level guarding**: menu/nav gating is not enough — direct page entry, deep links, and action buttons tied to welfare must fail closed too.
6. **Man-down status visibility**: whether detection is active, paused, org-disabled, or officer-disabled must be shown to the officer in plain language.
7. **Alert lifecycle visibility**: if movement auto-resolves an alert (pending the required-acknowledgement fix above), the officer-facing wording must make that resolution reason explicit — it must not look like the alert vanished arbitrarily.
8. **No loading flicker on safety-sensitive tabs**: a safety-relevant nav item must not briefly appear then disappear while config loads — that teaches the user the feature exists for them even when it does not.
9. **Access explanation, not a dead end**: when a user cannot open welfare-related UI, give a compact explanation and the responsible scope (e.g. "contact your administrator") rather than nothing.

### Implementation priority (Bob's own recommendation, adopted)

Focus first on: distinct empty/error/loading states, fail-closed messaging for welfare, and officer-visible man-down status text. Everything else in the list follows the same shared-message-source pattern once those three exist.

## Verified ReportButton.tsx submission logic (lines 281-534)

`ReportButton` requires GPS plus location context (zone/site ID, resolved address, or officer-entered address) before allowing submission, with a deliberate offline exception: if the location resolver failed, GPS-only submission is allowed and the record is marked as needing server-side location resolution — derived from column state (`gps_lat` set, `zone_id`/`site_id`/`address` all null), not a persisted flag. This is a reasonable offline-resilience pattern worth preserving.

Confirmed error-handling is **inconsistent across the codebase**, not uniformly absent as the welfare-check-in finding alone might suggest:

- The primary `officer_field_reports` insert **does** check its error and surfaces it to the officer (`if (repErr) { setError(repErr.message); return; }`) — this is the correct pattern.
- The **LOI** (location-of-interest) `entity_flags` insert, triggered automatically for high/critical severity or when explicitly checked, has **no error check at all** — if it fails, the flag silently never exists and the officer is never told, unlike every other failure path in this same file.
- The **VOI** (vehicle-of-interest) plate resolution is wrapped in `try/catch` and defensively appends a failure note directly into the report (`oiNotes.push(...flag not saved...)`) rather than silently dropping it — this is the correct pattern and should be applied to the LOI insert as well.

### Required rebuild behavior

Apply the VOI insert's error-handling pattern (try/catch + user-visible failure note appended to the record) uniformly to every write in this component, including the currently-silent LOI insert. Do not treat "some inserts here are checked" as evidence the file is safe overall — verify each write individually.

## Verified: officer welfare-standby (no-shift) screen

`OfficerShell`'s "no shift assigned" state (spec §4 State 1, issue #7) confirms:

- Auto-refreshes every 30 seconds.
- Explicitly states in the UI copy: "Emergency SOS and welfare check-in are always available above" — i.e. safety controls are confirmed NOT gated behind shift assignment, only operational modules are. Preserve this exactly; it is a correct safety property.
- Quick actions available with no shift: My Schedule, standalone module open (`onOpenModules`, optional — the condition that makes it available is not yet known and must not be guessed at), Vehicle Lookup, My Credentials, Submit Field Report, Request Leave, Submit Timesheet.
- Open shifts can be accepted/declined directly from this screen via `respond(id, status)`.

### Systemic pattern, not an isolated bug: unchecked Supabase writes

`respond()` performs `await supabase.from('shifts').update({ status }).eq('id', id)` with no error check — if it fails, the UI still calls `onRefresh()` and the officer sees no indication their accept/decline did not save. This is now the **third** confirmed instance of the same defect class across three unrelated files:

1. `useWelfareCheckin.ts` — `checkIn()` and `triggerSOS()` (safety-critical).
2. `ReportButton.tsx` — the LOI `entity_flags` insert (evidence-integrity).
3. `OfficerShell.tsx` — shift accept/decline (operational).

Three occurrences across independently-audited files is enough to treat this as a **systemic gap in the original codebase's write-error handling**, not a one-off. The rebuild should adopt one shared, mandatory pattern (e.g. a thin wrapper around every mutating Supabase call that requires the caller to handle `{ error }`, enforced by lint/type rather than convention) rather than fixing each call site independently and hoping the next one remembers.

## Verified RoleRouter.tsx contract

`RoleRouter.tsx` (source of truth: `docs/INSTRUCTION_MANUAL.md` §2.3) is the single role-to-shell dispatcher. Confirmed role → expected URL prefix → shell mapping:

| Role(s) | Expected prefix | Shell | Route shape |
|---|---|---|---|
| `grand_master`, `master`, `admin`, `nzscv_monitor` | `/admin` | `AdminShell` | `/admin`, `/admin/:page` |
| `admin_officer` (after portal choice) | `/admin` or `/officer` | `AdminShell` or `OfficerShell` | as above / below |
| `officer` | `/officer` | `OfficerShell` | `/officer`, `/officer/:module` |
| `scan_operator` | `/scan` | `ScanShell` | `/scan` only (no dynamic segment) |
| `client_admin`, `client_officer`, `client_viewer` | `/client` | `ClientShell` | `/client`, `/client/*` (wildcard, not a named param) |
| any other role string | none | inline "Unknown role" message | none |

Confirmed behavior:

- `admin_officer` with no stored portal choice sees `PortalSelector` (a full-screen admin/field choice) before any prefix logic runs.
- The portal choice is persisted in `sessionStorage` under `fcm.admin_officer.portal` (tab-scoped, cleared on sign-out per the UI's own copy: "You can switch portals by signing out and back in"). This is a deliberate, correct pattern — unlike the `localStorage`-based `fcm:searchPlate` finding elsewhere, this one should be replicated as-is, not fixed.
- URL-prefix mismatch triggers `<Navigate to={expectedPrefix} replace />`.
- `ClientShell` uses a wildcard (`/client/*`) rather than a single named segment, meaning it owns its own nested routing internally — structurally different from `AdminShell`/`OfficerShell`, which each get one dynamic segment (`:page`/`:module`) from `RoleRouter` itself. The rebuild must preserve this asymmetry rather than normalizing all four shells to the same routing shape.

### Verified defect: silent blank screen when profile is null

```tsx
if (loading) return <LoadingScreen />;
if (!profile) return null;
```

Once `loading` is `false`, a `null` profile (failed fetch, missing profile row, revoked access, race condition) renders literally nothing — no loading indicator, no error message, no sign-out option. This is a real accountability/UX gap: the user sees a blank page with no explanation and no way to recover except manually navigating away or refreshing. The rebuild must add a distinct "profile unavailable" state with an explanation and a sign-out action, not `return null`.

### Verified defect: prefix matching uses `startsWith`, not a boundary check

```tsx
if (!path.startsWith(expectedPrefix)) {
  return <Navigate to={expectedPrefix} replace />;
}
```

`path.startsWith('/admin')` is also `true` for a hypothetical `/administrator` or `/admins` path — there is no current colliding route, but the check has no path-boundary guard (`path === expectedPrefix || path.startsWith(expectedPrefix + '/')`). The rebuild should use a boundary-safe prefix check from the start so a future route addition can't silently bypass role enforcement.

### Verified defect: unknown-role screen is a dead end

The `else { return <div>Unknown role: {role}...</div>; }` branch has no sign-out action and no navigation escape — a user who somehow reaches this state is stuck on a static message. The rebuild should offer sign-out from this screen.


## Verified legacy URL compatibility surface

Bob's latest read confirms that `AdminShell.tsx` maintains a broad `LEGACY_REDIRECTS` map while exposing a smaller canonical `AdminPage`/`VALID_ADMIN_PAGES` set. Legacy slugs for CRM, roster, field operations, reporting, and other admin areas resolve into consolidated parent containers with child tab or sub-area state.

The compatibility map is part of the product contract: bookmarked links must continue to open the intended operational view after navigation consolidation. The canonical page type, valid URL set, redirect target interface, container tab types, `RoleRouter`, and child module gates are separate structures and therefore need synchronized validation.

### Route-contract drift risk

A legacy slug can be syntactically recognized yet still fail semantically if its target tab is removed, its module is disabled, its role is not permitted, or the container no longer accepts the target state. Route tests must cover every redirect target, canonical URL replacement, child tab selection, module state, and role/prefix combination. A redirect is not proof of authorization.

The current source confirms that `VALID_ADMIN_PAGES` contains only canonical container/page keys, while `LEGACY_REDIRECTS` contains dozens of older CRM, roster, field-operations, and reporting slugs. The redirect table therefore acts as a second route registry. Its child values must be validated against `CRMFinanceTab`, `RosterHRTab`, `FieldOpsSubArea`, and `ReportsTab`; TypeScript shape alone does not prove that every string is still accepted by the child page.

### P0 legacy-route render-phase side effect (corrected)

Earlier evidence (a partial read) suggested `pageFromUrl()` could call `setCrmTab`/`setRosterTab`/etc. before those setters exist, causing a temporal-dead-zone crash. The complete function body shows this was wrong: `crmTab`, `rosterTab`, `fieldOpsSubArea`, `reportsTab`, and `site360Tab` state (and their setters) are all declared *before* `pageFromUrl` is defined and before `activePage`'s `useState(() => pageFromUrl(location.pathname))` initializer calls it, so there is no reference-before-declaration failure.

The real defect is narrower but still real: `pageFromUrl` is passed as a **lazy `useState` initializer**, and it calls other components' `setState` functions (`setCrmTab`, etc.) as a side effect of computing the initial value. React expects initializer functions to be pure. Consequences:

- In React 18 `StrictMode` (dev), initializer functions are invoked twice, so a legacy URL like `/admin/invoicing` will call `setCrmTab('invoicing')` twice on mount — harmless here since it is idempotent, but it signals a render-phase side effect that React does not guarantee runs exactly once.
- The same `pageFromUrl` logic is duplicated in the separate `popstate`/`location.pathname` sync effect (URL sync on browser back/forward), so tab-state setters can fire from two different code paths for the same URL, making the source of truth for "which tab is selected" harder to reason about.
- Because the setters fire during the initial render pass (not after commit), any logic that assumes `crmTab` is still `'crm'` (the default) during that very first render will observe stale state until the extra re-render settles.

The fix is still to make `pageFromUrl` pure: return `{ page, crmTab?, rosterTab?, fieldOpsSubArea?, reportsTab? }` and apply the child-tab values in one place (either the initial `useState` default computed inline, or a single `useEffect` keyed on `location.pathname`), rather than mutating other state from inside a value-computing function. Add a regression test asserting `setCrmTab`/etc. are each called at most once per distinct URL.

### Verified silent module-gate fallback

When `isPageEnabled(activePage)` returns false, the shell renders `AdminHubPage` without explaining whether the requested page is disabled, unavailable, or unauthorized. The fallback prevents the gated page from rendering, but the silent replacement can confuse operators and hide a policy-source problem. The UI should provide a truthful, accessible reason while avoiding disclosure of protected module details.

### Uneven container gating inputs

`FieldOperationsPage` and `ReportsPage` receive `enabledModules` and `isPlatformOperator` directly. CRM & Finance, Roster & HR, and Site 360 receive no equivalent module-gating props in this render path. This may be intentional because their child gates use another contract, but it must be verified rather than assumed; otherwise module policy can be enforced unevenly across the consolidated navigation.

### Search navigation bypasses the shell's own context channel

`handleSearchNavigate()` writes a `vehicle-search`/`breach-review` plate value to `localStorage` (`fcm:searchPlate`) instead of passing it through `pageExtra`, route state, or a prop, even though the shell already has that exact channel for record-scoped navigation (`record_id`/`targetRoute` in `getBobContext()`). This creates a second, untyped, un-scoped state path that:

- is not visible to `getBobContext()` or Bob's page context
- persists across navigations and sign-out/sign-in unless explicitly cleared
- can leak a stale plate into an unrelated later visit to the same sub-area
- is not organisation-scoped, unlike the rest of the shell's state

This should be routed through the existing `pageExtra`/context channel rather than `localStorage`, and `fcm:searchPlate` should be cleared once consumed.
## Verified current Admin Hub structure

The original repository contains `apps/web/src/pages/AdminHubPage.tsx`. The current evidence confirms these areas:

- Operations Centre / Admin Hub heading
- KPI tiles for scans today, active breaches, patrols running, and welfare alerts
- Sticky priority-action bar
- Compliance Trend chart with 7-day, 14-day, and 30-day ranges
- Module navigation cards
- Grand Master NOC terminal

Verified Admin Hub data sources from the original component:

| UI value | Source | Filter |
|---|---|---|
| Scans today | `observations` | `organization_id`, `observed_at >= today` |
| Active breaches | `breach_alerts` | `organization_id`, status `open` or `acknowledged` |
| Patrols running | `shifts` | `organization_id`, active status and current scheduled window |
| Welfare alerts | `officer_welfare_alerts` | `organization_id`, status `open` |

The page refreshes KPI and trend data every 60 seconds and provides a manual refresh action.

## Verified Admin Hub functional findings

Bob's read-only inspection of `apps/web/src/pages/AdminHubPage.tsx` confirmed:

- `organizationId` is live from the authenticated profile and gates all KPI/trend loading.
- KPI queries are live Supabase reads and are organisation-scoped.
- Trend scans count `observations.observed_at` rows by day.
- Trend breaches count `breach_alerts.created_at` rows by day.
- Missing trend days are zero-filled in component code.
- Patrol status values and breach status values are hard-coded filter criteria.
- Trend ranges (`7d`, `14d`, `30d`) and the 60-second refresh interval are configured in component code.
- The Grand Master NOC visibility check is hard-coded to `profile.role === 'grand_master'`.
- The NOC operational values are all hard-coded, including service online states, latency, model, provider, branch, organisation, and database pool values.
- The manual refresh action calls the KPI loader only; it does not refresh the trend data. Automatic refresh calls both loaders.
- The inspected functional code has no explicit Supabase error checks, `try/catch`, or user-facing error state for KPI or trend failures.

## Priority UI integrity gaps

### P0: static operational telemetry

The NOC currently presents hard-coded values as current operational truth. This is not acceptable for an accountability platform. Replace each value with a live health source, or label it explicitly as unavailable, configured, or last-known with a timestamp. Do not display green online status without evidence.

### P1: failed reads collapse into misleading values

The loaders use nullish zero defaults and do not expose query failures. A failed query must not look like a valid zero count. Add independent error state for KPI and trend data, preserve the last successful value where appropriate, show freshness, and provide a retry path.

### P1: manual refresh is incomplete

The visible refresh action updates KPI values but not the trend chart. It must refresh both, or the UI must clearly separate the controls and their scopes. The preferred behavior for an Admin Hub refresh is one coordinated refresh with independent success/failure reporting.

### P1: chart scale must use both series

Trend rendering must scale against `Math.max(scans, breaches, 1)` for the selected range. It must support valid zero-scan/breach data, prevent overflow, and provide a textual/table representation for accessibility.

### P2: role and status contracts need central ownership

The `grand_master` role check and status filter arrays are embedded in the component. Before changing them, verify the canonical role and status definitions in the shared auth/schema contracts. Do not duplicate policy values across screens without a deliberate compatibility rule.

## Complete Admin Hub audit evidence

Bob's complete functional read confirms the following implementation details:

- `useAuth()` supplies the live profile and `profile.organizationId` is the tenant boundary for every KPI and trend query.
- `useIsMobile()` supplies the computed responsive flag.
- KPI and trend data use direct Supabase reads; no non-Supabase API is used in the inspected functional section.
- The trend loader reads `observations.observed_at` and `breach_alerts.created_at`, aggregates rows into local date buckets, and zero-fills missing days.
- The KPI loader reads `observations`, `breach_alerts`, `shifts`, and `officer_welfare_alerts` with organisation filters.
- Patrols running is a derived operational metric based on shift status and the current `scheduled_start`/`scheduled_end` window. It is not a count from the legacy `patrols` table.
- The Grand Master NOC is shown only when `profile.role === 'grand_master'`, but every visible NOC service status, model, latency, provider count, branch count, organisation count, and database pool value is hard-coded in JSX.
- Query result errors are not checked. Missing rows/counts become empty arrays or zero values, and loading ends normally. A failed read can therefore look like a healthy zero result.
- The manual refresh button invokes `loadKpi` only. It does not invoke `loadTrend`; the automatic 60-second refresh invokes both.
- Role names, status arrays, date ranges, refresh interval, and fallback labels are embedded in the component rather than imported from shared contracts.

### Required first implementation slice

The first Admin Hub change should be a truthfulness and state-integrity pass:

1. Replace hard-coded NOC status and metrics with a live health/telemetry source, or render each value as unavailable/configured/last-known with a timestamp.
2. Add separate KPI and trend error state. Preserve the last successful data where appropriate, identify freshness, and never convert a failed query into zero.
3. Make manual refresh reload KPI and trend data together with independent result handling.
4. Scale trend bars using the maximum of both displayed series and add an accessible textual or tabular summary.
5. Add tests for query failure, zero valid results, stale data, breach counts greater than scan counts, and manual refresh behavior.

Do not combine this slice with a visual redesign or route expansion. It changes the meaning of operational information and should be reviewed as a data-integrity change first.

## Confirmed navigation targets

The Admin Hub evidence includes navigation to these logical areas:

- `patrol`
- `breach-review`
- `hub`
- `fc-reporting`
- `fc-notice-print`
- `fc-compliance`
- `fc-scv-import`
- `fc-nzscv`
- `field-reports`
- `live-map`
- `welfare-alerts`
- `dispatch`
- `roster`
- `staff`

Each target still requires verification against the original route registry, component file, and permission guard before implementation depends on it.

## UI states required for every operational surface

Every KPI, chart, card, table, upload, and action must define:

- loading: what is being fetched and which actions are disabled
- empty: no records, with a truthful explanation
- unavailable: source or service cannot currently be reached
- stale: last successful update time is visible where operational freshness matters
- error: safe user-facing message with retry path and correlation reference
- success: confirmation tied to the resulting record or artifact
- permission denied: explain that access is restricted without disclosing protected data
- partial: distinguish available sections from sections that failed

Zero must not be used to represent an unknown or failed query.

## Admin Hub review items

### NOC truthfulness

The NOC styling presents green online status and operational values such as latency and model status. The functional source must verify whether those values are live health data, configured values, or hard-coded JSX. Static operational claims must be replaced with live evidence or explicitly labelled as unavailable/configured.

### Trend chart integrity

The chart must scale against the largest displayed series, not scans alone. It must correctly represent zero scans with breaches if that is valid data, and must not allow a breach bar to overflow or imply a false ratio.

The chart needs a non-visual equivalent, such as a data table or accessible textual summary, including date, scans, breaches, and the selected range.

### Accessibility

Verify and implement:

- keyboard focus and activation for all navigation controls
- accessible names for icon-only or icon-led controls
- visible focus states
- semantic buttons or links appropriate to the action
- status announcements for loading, errors, and successful actions
- chart data available to screen readers without relying on color or square characters
- sufficient contrast for muted labels and status colors
- responsive behavior at narrow mobile widths

### Visual language

The current evidence uses dark inline-style cards, rounded borders, emoji icons, and an Inter/monospace NOC style. Before changing this, inspect the original repository's shared design tokens, icon library, typography, and layout primitives. Do not introduce a new visual system for one page.

## Document upload and Bob workflow

The UI must preserve this chain:

`file selection -> private storage object -> attachment record -> extraction -> document understanding -> Bob response -> human decision`

For each uploaded file, the UI should expose or make inspectable:

- original filename
- file type and byte size
- upload timestamp
- uploader and organisation context
- processing state
- extraction success or failure
- checksum/provenance where appropriate
- confidence and manual-review requirement
- source text availability without exposing protected content to unauthorized users

A successfully uploaded file is not the same as a successfully extracted file. Bob must not assess appropriateness from an empty extraction.

## Initial component inventory

To be confirmed from the original repository:

- application entry point
- root router and role router
- authentication provider and session context
- shared layout and sidebar/navigation
- Admin Hub page
- dashboard/KPI components
- upload and attachment components
- document viewer or understanding surface
- compliance and breach review surfaces
- reports and notice-print surfaces
- Bob chat and response rendering
- shared API/Supabase client
- loading, error, empty, and permission components

## Verified original UI architecture

Bob's repository search has verified the following routing and identity spine:

- `apps/web/src/main.tsx` is the `BrowserRouter` entry point.
- `apps/web/src/App.tsx` references `AuthContext` and `RoleRouter` and is a primary application composition point.
- `apps/web/src/routing/RoleRouter.tsx` is a real routing entry and must be read before changing page access or navigation.
- `apps/web/src/context/AuthContext.tsx` is the primary auth/profile definition and is consumed by the app, role router, shells, and multiple pages.
- `createBrowserRouter` was not found, so the data-router API is not currently evidenced.
- The app uses `BrowserRouter`; nearby alternatives such as `Routes`, `useRoutes`, or wrapped router abstractions still require verification.

The actual shared Sidebar component is not yet verified. Search results were capped and surfaced `PortalSwitcher.tsx`, `CrmBranchPicker.tsx`, `App.tsx`, and `RoleRouter.tsx` as candidates, but none should be treated as the Sidebar implementation until Bob reads the exact files.

### Required next routing reads

1. Read `apps/web/src/main.tsx`.
2. Read `apps/web/src/App.tsx`.
3. Read `apps/web/src/routing/RoleRouter.tsx`.
4. Read `apps/web/src/context/AuthContext.tsx`.
5. Search and read the exact shared shell/navigation component.
6. Trace route-level permission checks to the canonical profile/role source.

## Verified shell and route permission map

Bob's read-only inspection has now verified the shared admin shell and role router:

- `apps/web/src/shells/AdminShell.tsx` is the shared admin/master/grand-master portal shell.
- `AdminShell.tsx` imports `NotificationsBell`, `PortalSwitcher`, `UniversalSearch`, `BobPanel`, and `LazyPageFallback`.
- Navigation chrome is consolidated in `AdminShell.tsx`; `RoleRouter.tsx` chooses the shell but does not own the shared admin chrome.
- `apps/web/src/routing/RoleRouter.tsx` enforces both role-to-shell selection and expected URL prefixes through redirects.

| Role | Expected prefix | Shell |
|---|---|---|
| `grand_master`, `master`, `admin`, `nzscv_monitor` | `/admin` | `AdminShell` |
| `admin_officer` | `/admin` or `/officer` after portal choice | `AdminShell` or `OfficerShell` |
| `officer` | `/officer` | `OfficerShell` |
| `scan_operator` | `/scan` | `ScanShell` |
| `client_admin`, `client_officer`, `client_viewer` | `/client` | `ClientShell` |
| unknown role | none | inline access error |

Verified route shapes include `/admin`, `/admin/:page`, `/officer`, and `/officer/:module`; catch-all routes redirect to the relevant shell root.

### Authorization boundary caveat

Parent shell and URL-prefix access are verified, but not every internal navigation item or tab-level gate has been read end to end. The original architecture comments state that module gating also occurs inside container pages at tab/card level. Any UI change must therefore verify both the `RoleRouter` shell gate and the target page's internal permission checks.

## Verified AdminShell behavior

Bob's read-only inspection has verified the shared shell's desktop and mobile integration:

- Desktop navigation renders inside `AdminShell.tsx` with a collapsible sidebar.
- The desktop top bar displays the live organisation name, profile role, and display name/ID fallback.
- `NotificationsBell` can navigate to an admin page and open a Bob conversation.
- `UniversalSearch` routes through the shell's page navigation handler.
- `BobPanel` is mounted by the shell and receives page context, an optional initial conversation, and an optional seed prompt.
- Mobile navigation uses grouped menu items plus a bottom tab bar and also mounts the same `BobPanel` context.
- The shell sign-out action is available from both desktop and mobile layouts.
- Mobile and desktop controls use buttons for most navigation actions; `NavItem` is a `div` with `role="button"`, `tabIndex={0}`, click handling, and Enter-key handling.

### AdminShell implementation risks

- `NavItem` handles Enter but not Space, so keyboard activation is incomplete for a button-like control.
- `NavItem` uses a non-semantic `div` instead of a native button or link, increasing accessibility and focus-state risk.
- The shell's live organisation, role, and user identity are visible in the top bar, but downstream page data still requires independent organisation and role enforcement.
- Bob receives shell page context, but every page-specific Bob action must still be checked against the active page's actual data and permission boundary.

The next shell implementation check is to read the complete `NAV_GROUPS`, `MOBILE_NAV`, `navigate`, `renderPage`, and `getBobContext` definitions, then compare every target against `RoleRouter` and the container-page tab gates.

## Verified AdminShell architecture contract

Bob's complete header read confirms that `AdminShell.tsx` is governed by `docs/INSTRUCTION_MANUAL.md` section 4.1 and implements the Phase 1 navigation information architecture:

- The former flat navigation is consolidated into CRM & Finance, Roster & HR, Field Operations, and Reports containers.
- Legacy bookmarked URLs are redirected to the correct parent container with the relevant tab or sub-area selected.
- Module gating occurs inside tabs/cards as well as at the parent shell/router boundary.
- Bob context is specific to each tab or sub-area, preserving the specificity of the former flat navigation rather than giving Bob only a generic shell label.
- Heavy container pages are loaded with `React.lazy` and named-export adapters for route-level code splitting.
- Lightweight type/context extraction modules are imported separately so importing the shell does not pull all heavy component trees into the main bundle.
- The shell uses React Router location/navigation primitives and the shared auth, Supabase, notification, portal, search, Bob, and lazy-fallback components.

The verified shell imports establish these dependency boundaries:

- React state/effect hooks and React Router location/navigation are shell infrastructure.
- `AuthContext` supplies identity and profile context.
- The Supabase client is available directly to the shell.
- Admin Hub, site, access, organisation, user, platform, testing, and approvals pages are eagerly imported as shell-critical pages.
- CRM & Finance, Roster & HR, Field Operations, Reports, and Site 360 containers are lazy-loaded with named-export adapters.
- The lightweight `crmFinanceTypes`, `rosterHRTypes`, `fieldOpsTypes`, `reportsTypes`, and `site360Types` modules carry tab types and Bob context without importing heavy component trees.

The header also identifies `docs/INSTRUCTION_MANUAL.md` section 4.1 as the shell's source of truth. That document must be recovered or verified in the original repository before changing the navigation information architecture.

### Bundle-boundary verification

The consolidated container pages are explicitly lazy-loaded, while Admin Hub, site, access, organisation, user, platform, testing, approvals, and shared chrome components are eagerly imported. This may be intentional for shell-critical or frequently used surfaces, but it should be checked against the production bundle output rather than assumed to keep the initial bundle small. Any change to eager/lazy boundaries must preserve shell stability, loading fallback behavior, and Bob context availability.

### Architecture preservation rules

Future UI changes must preserve:

1. Legacy URL compatibility and selected-tab behavior.
2. Parent and child/module authorization checks.
3. Specific Bob context for the active tab/sub-area.
4. Lazy loading for heavy container trees and a visible loading fallback.
5. The authoritative instruction-manual contract, with any intentional change recorded as a reviewed architecture decision.

## Verified AdminShell rendering and module-gate contract

Bob's latest read confirms the shell applies a module gate before rendering the active page:

- If `isPageEnabled(activePage)` is false, the shell falls back to `AdminHubPage` instead of rendering a disabled or unauthorized deep-linked page.
- Lazy container pages are wrapped in `React.Suspense` with `LazyPageFallback` inside the shell's main content area.
- The sidebar, top bar, and shell chrome remain mounted while a lazy page chunk loads.
- CRM & Finance receives an initial tab, tab-change callback, site-zone configuration callback, and Bob-context update callback.
- Roster & HR receives an initial tab and tab-change callback.
- Field Operations receives an initial sub-area, sub-area callback, enabled-module state, and platform-operator state.
- Reports receives an initial tab, tab-change callback, enabled-module state, and platform-operator state.
- Site 360 receives an initial tab, tab-change callback, and a navigation callback to Locations.
- Sites and CRM can update shell-level `pageExtra`, which is converted into first-class Bob context fields such as `record_id` and `targetRoute`.

### Rendering and authorization preservation rules

Future UI work must preserve these behaviors:

1. Evaluate module availability before page rendering, including stale-state and deep-link entry.
2. Fall back to a truthful accessible hub state when a module is unavailable.
3. Keep Suspense boundaries inside page content so navigation and identity chrome remain stable.
4. Preserve initial tab/sub-area state and change callbacks across route compatibility redirects.
5. Keep record IDs, target routes, and other page context available to Bob without duplicating first-class fields inside an opaque `extra` object.

## Verified module-gating risk

Bob's latest read confirms that `AdminShell.tsx` derives navigation and rendering from `organization_modules`, but `isPageEnabled()` returns `true` when `enabledModules` is `null`. The same `null` state is used while modules are loading and when the module query fails. The documented intent is fail-open so existing admins are not locked out, but this means a non-platform user can see and deep-link to module pages without the organisation's enabled-module state being successfully verified.

Platform operators (`grand_master` and `master`) intentionally bypass module gating. Other roles should not receive that bypass implicitly through a missing, delayed, or failed module query.

### Priority authorization issue

Treat module state as a tri-state contract rather than a nullable Set:

- `loading`: render a loading/fallback state and do not authorize gated pages yet.
- `configured`: show only enabled modules.
- `unconfigured`: allow the documented product behavior only if the database explicitly confirms that no module configuration exists.
- `error`: show an unavailable state and block gated navigation until the authorization source is verified.

The current implementation conflates `loading`, `unconfigured`, and `error`. This is a P1 authorization and accountability issue because visibility and deep-link access can become broader when the policy source is unavailable. Any fix must preserve platform-operator access and test stale URL entry, query failure, empty configuration, and enabled/disabled module cases.

The organisation-name query also has no visible error or stale-state handling; a missing name should be represented as unavailable rather than silently leaving the shell context ambiguous.

## Verified AdminShell state and navigation findings

Bob's latest read confirms:

- Top-level navigation is intentionally limited to Core, Config, and System groups, with Platform appended for `grand_master`.
- Mobile bottom navigation exposes only the top-level container pages: Home, Field Ops, Roster, CRM, and Reports.
- `PAGE_REQUIRED_MODULE` is empty at the shell level in Phase 1; module gating is delegated to the CRM, Field Operations, and Reports container pages.
- Shell state tracks the active CRM tab, roster tab, field-operations sub-area, reports tab, and Site 360 tab so legacy URLs can select the correct child view.
- `pageFromUrl()` parses the URL and also sets child tab/sub-area state when it resolves a legacy redirect.

### Render-phase mutation risk

Because `pageFromUrl()` is used to derive active page state and performs `setCrmTab`, `setRosterTab`, or `setFieldOpsSubArea` during that derivation, legacy URL resolution can mutate React state during render. This should be moved into an effect or an explicit navigation-resolution step that returns both page and child state before applying state updates.

Required regression coverage:

- legacy URL resolves to the expected container and child tab
- browser back/forward does not trigger render-phase updates
- repeated renders do not reset a user's selected tab unexpectedly
- canonical URL replacement preserves the selected child context

### Delegated gating dependency

With no top-level required modules, the safety of module access depends entirely on child container gates. Any container that forgets to apply `enabledModules` can expose its whole sub-area even though the shell appears to support module gating. The tri-state module-loading fix must therefore be shared by every container page, not implemented only in `AdminShell`.

## Verified AdminShell route taxonomy

Bob's read-only inspection confirms that `AdminShell.tsx` provides a compatibility map from legacy page slugs into consolidated containers:

- Field operations sub-areas include patrol, routes, monitoring, checkpoints, checkpoint logs, live map, welfare, vehicle search/flags, field reports, breach review, SCV import, notice print, NZSCV, overnight, enforcement, homeless claims, disputes, parking, noise control/settings, biosecurity, and smoke control.
- Reporting sub-areas include command results, reports hub, report packs, obligations, compliance, and FC reporting.
- CRM and roster legacy slugs are similarly mapped into their respective container tabs.
- The active top-level page set is intentionally smaller than the legacy surface and is validated through `VALID_ADMIN_PAGES`.

The shell passes Bob a top-level `PAGE_CONTEXT` such as Dashboard, CRM, Roster, Field Operations, Reports Hub, Sites, Access Control, Approvals, Testing, or Platform. Container pages own their own tab/sub-area context, so Bob's shell context alone is not sufficient to authorize or reason about a specific field-operations or reporting action.

### Route-impact rule

Any UI change to a legacy slug, consolidated container, tab, or sub-area must verify all three layers:

1. Legacy redirect compatibility.
2. `VALID_ADMIN_PAGES` and `RoleRouter` prefix/role access.
3. Container-page tab gates and the page-specific Bob context.

## Verified shell control details

Additional AdminShell evidence confirms:

- Mobile page content renders above a bottom tab bar, with Bob as an additional tab-like control.
- Desktop page content renders beside a collapsible sidebar with grouped navigation items.
- The desktop collapse control has an accessible label and title that change with its state.
- Navigation items are delegated through `navigate` or `navigateToPage`, preserving the shell's compatibility mapping.
- `BobPanel` receives the current shell context in both layouts, along with initial conversation and seed-prompt state.
- The desktop shell loads the Iron Eagle logo from a hard-coded public Supabase Storage URL.

### Additional review items

- Mobile tab buttons need explicit current-page semantics such as `aria-current` or an equivalent accessible state; visual active styling alone is insufficient.
- Bob's button should expose whether the panel is open and should preserve keyboard/focus behavior in both mobile and desktop layouts.
- The public logo URL is an external runtime dependency. It needs a documented availability/fallback state or a local/controlled asset strategy; a broken asset must not make the shell appear unbranded or misrepresent service ownership.
- Desktop `NavItem` still uses the previously noted `div` button pattern and should be replaced with native button/link semantics or fully tested keyboard behavior, including Space activation.

The final shell read adds two specific control-state gaps:

- The desktop sign-out control renders only `⎋` when the sidebar is collapsed and has no state-aware `aria-label` or title in that branch, leaving the action ambiguous to assistive technology.
- The Bob toggle has `aria-label="Open Bob AI assistant"` even when the panel is open and does not expose `aria-expanded` or an associated panel relationship.

The shell accessibility fix should give every stateful control a stateful accessible name/current state, and should use native buttons or links wherever the interaction is a command or navigation action.

## Verified AdminShell rendering and mobile menu findings

Bob's latest source read confirms that `renderPage()` maps the consolidated admin pages to concrete page components, including Approvals & Activity, Testing, Test Data Entry, Grand Master Platform, Module Catalog, Provider Subscriptions, and Owner Billing. Its default branch returns `AdminHubPage` with the shell navigation callback.

The mobile shell includes:

- public organisation context in the top bar
- an admin-to-field `PortalSwitcher` for `admin_officer`
- `NotificationsBell` on mobile
- a menu toggle and full-screen grouped navigation overlay
- a sign-out action inside the overlay
- a bottom tab bar and Bob panel

### Verified mobile menu defect

The `navigate()` helper is documented as “navigate and close the menu,” but its implementation only calls `navigateToPage(page)` and does not call `setMobileMenuOpen(false)`. Selecting a mobile menu item can therefore leave the full-screen overlay open over the newly selected page.

Required regression test: open the mobile menu, activate a menu item, verify navigation occurs, and verify the overlay closes.

### Mobile overlay requirements

- The menu toggle label should reflect state (`Open menu` versus `Close menu`) and expose `aria-expanded`/`aria-controls`.
- The close control should be keyboard reachable and Escape should close the overlay.
- Focus should move into the open menu and return to the toggle when it closes; background content should not remain accidentally interactive.
- Active mobile menu items and bottom tabs need accessible current-state semantics, not only visual styling.

## Evidence still required from Bob

Bob should fill these gaps through small, exact, read-only GitLab searches and reads:

1. Read `apps/web/src/main.tsx` and `apps/web/src/App.tsx`.
2. Locate and read `RoleRouter`.
3. Locate and read the shared layout/sidebar and route registry.
4. Read the complete functional portion of `AdminHubPage.tsx`.
5. Trace every Admin Hub data query to its API, RPC, or table contract.
6. Verify every Admin Hub navigation target and role guard.
7. Trace the upload path through attachment registration, extraction, inference, and response rendering.
8. Locate shared design tokens, icon libraries, typography, and responsive primitives.
9. Return exact source paths and distinguish verified facts from unknowns.

## Change-impact requirements

Any UI change must check its impact on:

- route registration and role access
- organisation scoping and RLS
- API/RPC response shape
- loading/error/empty states
- document and evidence provenance
- Bob tool selection and approval gates
- mobile and keyboard behavior
- tests, screenshots, and release artifacts

No UI implementation should be considered complete until the affected Atlas nodes and edges have been reviewed.

## Cross-app gating audit (open — not yet verified)

Fixing module gating in the shell/nav layer (`useEnabledModules`, `AdminShell`, `OfficerShell`) does not prove every other surface fails closed. A hidden nav item is not the same as a hidden or absent data layer: any page, panel, or subscription that reads state independently of the shell's gate, caches it differently, or trusts route access after initial load can still expose safety-relevant content or actions even when navigation to it is correctly hidden.

**UX rule**: for every safety-sensitive surface, the same four states must be shown, at both the action level and the data level, not just the menu level:

1. loading
2. unavailable — configuration/entitlement not yet verified
3. not enabled for this organisation
4. enabled

**Not yet verified — still needs Bob read-only evidence before any implementation**:

- **Heat map**: map layers, live pins, welfare overlays, filter chips, and legend/count badges. A hidden tab is not sufficient if the underlying data layer still renders once any map component mounts.
- **Dispatch**: direct-entry screens, incident panels, officer status cards, quick actions, and alert creation/resolution controls. Dispatch UIs are prone to "button visible because data already arrived" logic that bypasses gating entirely.
- **Live monitoring**: websocket/subscription consumers, polling hooks, and presence/state banners. Real-time code paths often bypass the gate checks the rest of the UI relies on.
- **Other systems**: deep links, bookmarked URLs, command palette/search results, mobile shortcuts, notifications, and API-backed dashboard widgets — any entry point that can reach a safety-relevant surface without passing through the shell's normal navigation gate.

**Standard to build to**: action-level and data-level fail-closed, not menu-level hiding. Every one of the surfaces above should render exactly the four states listed above and should be built on the shared `SafetyGate` component below rather than reimplementing the check.

**Implemented ahead of the specific findings**: `apps/web/src/components/SafetyGate.tsx` is a general-purpose enforcement point — it wraps `useEnabledModules`'s status/enabled output with `getModuleAccessMessage` and renders children ONLY when access is positively confirmed (`configured` and enabled for safety-relevant content). It is deliberately usable at the individual map-layer, panel-section, or action-button level, not only the page/route level, since that is exactly where the audit above expects gating to be missing. It does not, and cannot, verify the actual heat map/dispatch/live-monitoring source — that requires the reads below before those specific pages are rebuilt or wrapped.

**Next Bob reads (read-only, no implementation until evidence is in)**:

1. Locate and read the heat map component(s): map layer definitions, live pin data source, welfare overlay toggle, and any legend/count badge that reflects safety-relevant counts.
2. Locate and read the dispatch surfaces: incident panel, officer status card, quick-action buttons, and alert creation/resolution controls — specifically whether any of these check module/entitlement state before rendering or firing an action.
3. Locate and read the live-monitoring data path: websocket or subscription setup, polling hook, and any presence/status banner — specifically whether the subscription itself is gated or only the banner that displays its output.
4. Locate and read how deep links / direct route entry (bookmarked URLs, notifications, command palette) reach these same surfaces, and whether they pass through the same gate as normal in-app navigation.

### Partial evidence: `DispatchConsolePage.tsx` (lines 341-520 of 1568) has its own independent officer-GPS load, no `welfare_alerts` join or gating call visible in this window

Confirmed in this window only (treat as partial, not proof of absence — ~1180 lines remain unread):

- `DispatchConsolePage` loads the latest `officer_gps_log` row per officer itself (`.from('officer_gps_log').select(...).in('officer_id', officerIds).order('created_at', { ascending: false })`, keeping the first/most-recent row per officer) — this is a **separate query from `LiveMapPage`'s**, not shared logic, even though both read the same table. This answers part of the earlier open question: dispatch does NOT reuse `LiveMapPage`'s data-loading code, it duplicates the same pattern independently.
- The resulting `activeShifts`/`resources` objects carry `officerGpsLat`/`officerGpsLng`/`officerLastSeen` (and `gpsLat`/`gpsLng` on assigned dispatch resources) — but **no `welfare_alerts` read or join appears in this window**. If this holds across the full file, dispatch's officer status cards would have the same "GPS presence looks like a status" risk already found in `LiveMapPage`, independently duplicated rather than shared.
- **No module-gating call** (`useEnabledModules`/`isModuleEnabled`) is visible in this data-loading window. Still open whether gating exists elsewhere in the file (e.g. at the shell/route level wrapping this whole page) — do not conclude "ungated" from this slice alone.
- Unrelated to the safety audit, also visible in this window: dispatch resource/callsign loading and a "Phase C" geofence-based requester-org picklist (PostGIS `ST_Contains` via RPC) for job payer resolution — noted for completeness, out of scope here.

**Next Bob read**: the remaining ~1180 lines of `DispatchConsolePage.tsx` (both before line 341 and after line 520), specifically to confirm/deny (1) any `welfare_alerts` read anywhere in the file, (2) any module-gating check wrapping the page or its officer-status rendering, and (3) whether officer status cards present any safety-relevant colour/state derived from this GPS-only data.

## Verified `LiveMapPage.tsx` findings (heat map + officer live monitoring, same screen)

Bob's read-only inspection resolved the "heat map" item from the cross-app gating audit above: officer live monitoring and the breach heat map are two views on one screen, `apps/web/src/pages/LiveMapPage.tsx` (`buildHotspots` ~lines 78-91, `showHeat`/`selected` state ~lines 149-150, zone/heat/officer map layers assembled together ~lines 270-272, GPS filtering ~line 203).

- **Officer live monitoring loads `officer_gps_log`**, keeps only the latest point per officer from the last 4 hours, and renders clickable officer pins. Positions auto-refresh every 30 seconds.
- **Displayed welfare status is derived from GPS age alone**: older than 1 hour → `offline`, otherwise → `ok`. No join against actual welfare alert state was found in the read slices. This is a substantive gap: the UI's own colour legend supports `due` and `alert`, but the load logic shown never produces those values — the map can present welfare semantics that look richer than the underlying data path actually is. An officer could be genuinely overdue or mid-alert and still render as a plain "ok" green pin as long as their GPS happens to still be fresh.
- **Heat map** buckets non-compliant `observations` from the last 30 days into concentration cells and renders them as graduated circles. Loads on initial page load and manual refresh, not on the 30-second timer. Operationally straightforward — not the risky part of this screen.
- **Zones** overlay boundaries and colour them red when there are open/acknowledged breach alerts.
- **Gating concern (unresolved)**: no module-gate hook or fail-closed guard was found in the recovered slices before loading officer positions, zones, or heat points. This matters concretely because this organisation's module overlay shows Welfare Monitoring as available but **not enabled** — if this page loads unconditionally, it may present officer welfare-like status regardless of that entitlement.

### Required rebuild behavior

1. Officer pin status must be derived from real welfare/safety state (`useOfficerSafety`'s `status`), not GPS recency. GPS age may still separately indicate `offline` (position unknown), but must never substitute for or suppress a real `due`/`overdue`/`alerting` state.
2. If welfare status has not loaded, is gated, or is otherwise unavailable, the pin must show an explicit unknown state — never default to `ok`.
3. The whole live-monitoring surface (officer pins, at minimum) must be wrapped in the same `SafetyGate`/`useEnabledModules` check used elsewhere, so this page is not the one place an ungated welfare-adjacent UI slips through. The heat map/zone layers are not safety-relevant in the same way and are lower priority for gating, but should still respect ordinary loading/error states.
4. Preserve the correct pieces as-is: GPS-log-based positions, 30-second officer refresh cadence, and observation-based heat bucketing are legitimate and not defects — do not change data sources, only how status is computed and gated.

**Implemented**: `apps/web/src/lib/officerPinStatus.ts` provides `deriveOfficerPinStatus({ gpsAgeMs, safetyStatus })`, combining GPS recency with `useOfficerSafety`'s real `SafetyStatus` so a live alert always wins (even over stale GPS — a phone going quiet does not cancel a real SOS), an unloaded/gated welfare status renders as `'unknown'` rather than defaulting to `'ok'`, and `due`/`overdue`/`ok` now actually reach the pin instead of being collapsed into GPS-age-only logic. 7 tests cover the priority ordering and the two "must never silently show ok" cases. Building the actual `LiveMapPage` component (map layers, hotspot rendering, zone overlays) is still blocked on one open question: which mapping library the original page uses (Leaflet/Mapbox/Google Maps/other) has not yet been verified — this should not be guessed at.

**Next Bob read**: confirm the mapping library via `LiveMapPage.tsx`'s imports (or `package.json`) before any map-rendering code is written, then trace whether `LiveMapPage` is gated by the same module/config check used elsewhere, and whether dispatch panels or other pages import the same live-map data-loading logic.

### Resolved: `welfareSafetySignal.ts` is real, but neither map page imports it — the map-status gap is confirmed, not reframed

Read: `packages/shared/src/welfareSafetySignal.ts` (lines 1-240 of 448), `apps/web/src/pages/OfficerMapPage.tsx` (full, 179 lines), `apps/web/src/pages/LiveMapPage.tsx` (lines 1-140 of 444), and the `docs/atlas/CODE_PATH_VIEW.md` rows for both pages.

- **What the module actually is**: a pure, I/O-free shared safety-policy module — not a UI module, and per its own header **not yet wired into the live conductor runtime**. It computes an "Oracle welfare truth-state" (`ok`/`due`/`overdue`/`man_down`/`sos`, plus escalation level and active-SOS/man-down/overdue booleans), whether there is an active safety concern, whether a proposed safety-signal effect is allowed under a hold, and Conductor safety precedence for candidate effects. Exports: `WelfareStatus`, `WelfareEscalationLevel`, `WelfareSignalType`, `OracleWelfareTruthState`, `hasActiveSafetyConcern`, `resolveOracleWelfareTruthState`, `validateSafetySignal`, `conductorSafetyPrecedence`.
- **Confirmed consumer list**: `packages/shared/src/index.ts` (re-export surface), `packages/shared/src/welfareSafetySignal.test.ts`, `supabase/functions/onspace-ai-chat/conductor-welfare-seam.ts` (the Conductor safety seam), and its test file. No UI page import was found in the visible slices.
- **The decisive fact**: neither `LiveMapPage.tsx` nor `OfficerMapPage.tsx` imports `welfareSafetySignal` — visible directly in each file's top import block, which was fully recovered for both. This is strong evidence (import statements are exactly the part of the file most likely to be captured intact), not a partial read.
- **`OfficerMapPage.tsx`, now fully read**: a separate, narrower officer-facing field map — one officer's own live GPS position, the active zone resolved via `shift_stops.zone_id` → `location_zones.boundary`, recentres on the officer, deliberately "big, simple, glove-safe." It is not a wrapper around `LiveMapPage` and reuses the same Leaflet + basemap pattern. `LiveMapPage` is the separate ops/admin map (many officers, zones, breach heat surface).
- **`LiveMapPage.tsx` confirmed**: uses Leaflet (map library question now settled). Officer pin status is still derived purely from GPS age (older than 1 hour → `offline`, else → `ok`) — not from the shared welfare truth-state module.
- **Atlas corroboration strengthened**: `CODE_PATH_VIEW.md` now also shows a `breach_alerts` read edge for `LiveMapPage` (in addition to `location_zones`, `officer_gps_log`, `observations`) — still no `welfare_alerts` edge for either page.

**Conclusion**: this does not reframe the original finding — it confirms it with source-level and atlas-level evidence from two independent angles. `LiveMapPage` (and `OfficerMapPage`) genuinely do not consume any welfare truth-state logic, shared or otherwise; they derive status locally from GPS recency alone. Notably, `welfareSafetySignal.ts` itself is described as not yet wired into the live conductor runtime, which means this gap likely exists in the current production app too, not just in a hypothetical bypass — `apps/web/src/lib/officerPinStatus.ts` in this rebuild is a genuine fix, not a solution to an already-solved problem. No change to the rebuild's implementation is required as a result of this finding.

**Remaining open, not yet answered**: whether `LiveMapPage`/`OfficerMapPage` are gated by the same module/config check used elsewhere in the app (the original cross-app gating audit question), and whether `DispatchConsolePage` (confirmed via code comments to read `welfare_alerts` directly, separately from this shared module) reuses any of the same GPS/officer-loading logic as `LiveMapPage`.

## ⚠️ Two unresolved evidence conflicts requiring a human decision before further safety-fix work — flagging rather than silently proceeding

### Conflict 1 — a product backlog document may describe "auto-resolve" as an INTENDED requirement, not a bug

A search surfaced `docs/WELFARE_MODULE_INVESTIGATION.md` line 122, a backlog row (truncated in transit): `W2 | GPS-stationary man-down: port `useManDownDetection` into the new OfficerShell (replace/augment the time-based man_down); auto-escalate + auto-resolve | h...`. Read literally, this is the product team's OWN backlog explicitly requesting "auto-resolve" alongside "auto-escalate" for the man-down feature — which would directly contradict this rebuild's P0 fix (movement/fixes can never resolve an alert; only explicit officer action can).

**This must not be silently resolved either way.** Two very different situations are consistent with this one truncated row:
- The backlog genuinely intends automatic resolution (e.g., movement is trusted as sufficient signal) — in which case the P0 "fix" in this rebuild is a deliberate deviation from stated product intent, and that deviation needs to be an explicit, informed decision by a human product owner, not something this audit imposes unilaterally.
- "Auto-resolve" here means something narrower/safer than what was implemented in `useManDownDetection.ts` (e.g., auto-resolve only after a supervisor/server-side confirmation step, or auto-resolve only below some severity threshold) — in which case the original *implementation* still deviated from even this intent, and the rebuild's fix is correct, but for a different reason than originally assumed.

Also note: `docs/WELFARE_MODULE_INVESTIGATION.md` line 73 states "Writes `check_in`/`sos`/`missed` alerts (!248). SOS latches." — "latches" strongly implies SOS specifically is NOT meant to auto-resolve (consistent with this rebuild's `triggerSOS`/`acknowledgeAlert` requiring an explicit clear). If "auto-resolve" in the W2 row applies only to the man-down/motion signal and not to SOS, that would be a materially different (and more defensible) scope than "nothing can ever require acknowledgement."

**Next Bob read, highest priority, before any further change to `useOfficerSafety.ts`'s resolve behaviour**: the FULL `docs/WELFARE_MODULE_INVESTIGATION.md` document, at minimum the complete W1/W2/W3 backlog rows (the visible row was cut off mid-word at "h...", likely a priority column) and any surrounding narrative that explains what "auto-resolve" was actually meant to mean and why.

### Conflict 2 — `welfareSafetySignal.ts`'s own `CURRENT_WELFARE_CHANNELS` list claims `live_map` IS wired, contradicting the "neither page imports it" finding above

`packages/shared/src/welfareSafetySignal.ts` (lines ~430-445) contains a `CURRENT_WELFARE_CHANNELS` array including `'live_map', // LiveMapPage officer pin colour-coded by welfare status`. This directly conflicts with the earlier, source-verified finding (this same document, section above) that neither `LiveMapPage.tsx` nor `OfficerMapPage.tsx` imports `welfareSafetySignal` at all, based on both files' fully-recovered top import blocks.

Two explanations are possible, and neither should be assumed:
- `CURRENT_WELFARE_CHANNELS` is aspirational/planning metadata (a list of channels that are *supposed* to consume welfare state) rather than a verified registry of actual imports — i.e. documentation-as-code that has drifted from the real implementation. This would be consistent with everything else found so far (module "not yet wired into the live conductor runtime").
- `LiveMapPage` consumes welfare state indirectly through something this audit hasn't traced yet (e.g. a shared hook, a different re-export path, or server-computed data already containing welfare state baked in before it reaches the page) — in which case the "GPS-age-only" finding could be incomplete rather than wrong.

**Do not resolve this by assumption.** The full context around `CURRENT_WELFARE_CHANNELS` (what reads this array, whether anything validates against it, whether it's just a comment/plan vs. an enforced list) needs to be read before treating either explanation as settled.

**Next Bob read**: full context of `packages/shared/src/welfareSafetySignal.ts` around lines 420-448 (the `CURRENT_WELFARE_CHANNELS` definition and whatever consumes it), to determine whether this is aspirational documentation or an enforced/consumed registry.

