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

### Verified OfficerShell.tsx findings (from windows actually shown)

- The module-selection screen shows an explicit user-facing note: "Only modules granted by your administrator are shown." This is a real pattern the Admin side lacks — recall the P1 "silent module-gate fallback" finding for `AdminShell`/`AdminHubPage`, where a disabled page falls back to the hub with no explanation. The rebuild should give Admin the same honesty the Officer side already has, not the other way around.
- `ModulePortal` is a shared wrapper: a "← Home" back button, module icon/title, optional zone name, module content, and a persistent `ReportButton` FAB shown only for genuine field modules (excluded for `report`, `leave`, `timesheet`, `schedule`, `overnight_verification`, `checkpoint_scan` self-service screens). This back+FAB pattern is worth preserving as-is.
- `ShiftCard` formats shift date/time explicitly in `Pacific/Auckland` (hard-coded IANA timezone, `en-NZ` locale) via `toLocaleDateString`/`toLocaleTimeString`. This is a legitimate regional business constant (not fabricated data like the NOC telemetry), but it is a hard dependency on NZ-only operation that should be called out explicitly in the rebuild rather than silently baked in again — confirm whether this should become a configured constant if multi-region support is ever a goal.

Do not assume `ScanShell`/`ClientShell` mirror `AdminShell`'s or `OfficerShell`'s structure just because the routing pattern looks similar — neither has been opened yet.

## Verified OfficerShell.tsx head content (lines 1-120)

`OfficerShell.tsx` cites a *different* source-of-truth document than the Admin side: `docs/PRODUCT_DESIGN.md` §3.1, §4 — versus `docs/INSTRUCTION_MANUAL.md` §4.1/§2.3 for `AdminShell`/`RoleRouter`. Neither document has actually been read yet; every "source of truth" comment cited across the audit so far has been treated as a pointer, not verified content. Both should be read before finalizing any rebuild decision that claims to follow them.

Confirmed structure:

- Four officer entry states: **welfare standby** (no active/upcoming shift, no direct module access), **officer home** (has a shift, roster-first landing), **module selector** (admin granted multiple direct modules), **module portal** (inside one module). Note this is a *shift-gated* authorization axis distinct from Admin's module-gated axis — officer module access depends on active shift state, not just permission grants.
- Persistent chrome on every officer screen: `FieldSafetyBar` (top) and `PttBar` (bottom) — the latter is very likely the frontend integration point for this repo's own `ptt-server/` push-to-talk backend service; this connection has not been separately verified and should be traced (does `PttBar` call `ptt-server/` directly, through an Edge Function, or through Supabase Realtime?).
- Hooks: `useWelfareCheckin` (verified), `useManDownDetection` (NOT yet read — see open question below), `useInactivityDetection` (not yet read), `useActiveShift` (not yet read), `useEnabledModules` (not yet read — see open question below).
- `OFFICER_MODULE_TO_CANONICAL` remaps officer-facing module keys to canonical `organization_modules` keys where they differ (e.g. `parking` → `parking_enforcement`, `smoke_control` → `smoke_complaints`, `site_guard` → `static_guarding`), citing `packages/shared/src/modules.ts` as the canonical source (also not yet read). This is the same kind of multi-structure-must-stay-synchronized risk already flagged for `AdminShell`'s `VALID_ADMIN_PAGES`/`LEGACY_REDIRECTS` pair — here it's `ActiveModule`/`VALID_OFFICER_MODULES`/`MODULE_META`/`OFFICER_MODULE_TO_CANONICAL`/canonical shared modules, all needing to agree.

### Resolved: `useManDownDetection.ts` is a separate trigger, not duplicate logic — but shares no state with `useWelfareCheckin`

Confirmed: `useManDownDetection` is a distinct, GPS-motion-based detector (`fireManDownAlert` fires when no movement is detected for `stationaryMinutes`), independent from `useWelfareCheckin`'s time-based missed-check-in detector. Both are legitimate, complementary signals for the same underlying safety condition — this is not code duplication.

The real gap: **the two hooks maintain fully independent local React state with no shared source of truth**, while both write toward `welfare_alerts`. Concretely:

- `useWelfareCheckin`'s `status` (`ok`/`due`/`overdue`/`man_down`/`sos`) and `useManDownDetection`'s `manDownState.isActive` are two separate state machines that can each independently reach an "alerting" condition for the same officer, with neither aware of the other.
- `resolveManDownAlert()` only resets `useManDownDetection`'s own local state; it does not touch `useWelfareCheckin`'s `status`, and `useWelfareCheckin.checkIn()` (the only reset path shown for its own state) does not touch `useManDownDetection`'s state either.
- The rebuild must unify these into one shared safety-state model (or explicitly document why they must stay separate) so a supervisor clearing one alert type can't leave the officer's device showing a contradictory safety state from the other detector.

Verified good patterns in this file (correcting the earlier "systemic unchecked-write" framing to be precise, not blanket): both `fireManDownAlert()` and `resolveManDownAlert()` correctly check `{ error }` before updating local state (`if (error || !data) return;` / `if (error) return;`), so a failed write does not falsely flip local safety state. This hook does **not** exhibit the unchecked-write defect found in `useWelfareCheckin`/`ReportButton`'s LOI insert/`OfficerShell`'s shift `respond()` — the systemic-pattern note above should be read as "confirmed in 3 of the files audited so far," not "true everywhere."

Also verified: `escalationMinutes` is intentionally loaded for settings/display only and explicitly **not** used for client-side escalation writes — the code comment states the server-side tick owns escalation timing. This is a correct, deliberate client/server separation of concerns and should be preserved as-is in the rebuild.

### Resolved: `useEnabledModules.ts` has the exact same fail-open ambiguity as `AdminShell` — and is the single shared fix point

Confirmed: `useEnabledModules` is the one shared hook used by both `AdminShell` and `OfficerShell` for module gating (a genuine consistency win — no drift between the two shells' gating logic). But it collapses three distinct states into one fail-open outcome: a transient query error, zero rows loaded yet, and a genuinely unconfigured organization all currently resolve to the same `configured: false` / "show everything" behavior. This is exactly the tri-state defect already recorded as a P1 issue for `AdminShell`, now confirmed to originate from this one shared hook rather than being duplicated per-shell.

Practical consequence flagged: if a module (e.g. welfare/man-down) is available platform-wide but deliberately not enabled for a given organization, a transient load failure could still expose it, because "not yet loaded" and "not entitled" currently look identical to callers.

### Required rebuild behavior for `useEnabledModules`

1. Fixing this single hook fixes module-gating consistency for both `AdminShell` and `OfficerShell` at once — do not patch each shell independently.
2. Expose four distinct states explicitly: `loading`, `error`, `unconfigured` (confirmed zero rows exist for this org), `configured` (rows loaded).
3. Non-critical UI discovery may still choose to fail open on `unconfigured` if that is a deliberate rollout decision, but `loading` and `error` must never be treated as authorization to show a gated feature.
4. Any safety-relevant or write-capable module (welfare/man-down included) must default to fail-closed until entitlement is positively confirmed as `configured`.

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
