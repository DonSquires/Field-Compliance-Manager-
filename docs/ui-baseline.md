# UI Baseline

Status: working baseline
Source: current repository evidence plus partial read-only findings from the original GitLab repository
Last reviewed: 2026-08-28

## Purpose

This document is the starting UI contract for Field Compliance Manager. It prevents future work from being designed as an isolated screen and keeps the interface connected to the operational, evidence, permission, and accountability model.

The baseline is intentionally split into verified facts, provisional findings, and open evidence. Items marked unknown must not be presented as settled product behavior.

## Product UI principles

- The interface must help staff create defensible service records: what happened, where, when, by whom, under what authority, and what evidence supports it.
- Bob is an operational copilot. He may explain, surface risk, and prepare governed actions, but consequential changes require human approval.
- The UI must preserve provenance and uncertainty. Unknown, unavailable, stale, and failed data need distinct states.
- Organisation scoping is mandatory. A screen must not display cross-organisation operational data unless the user's role explicitly permits it.
- Parent context must be visible before child actions: organisation, site, zone, patrol, incident, evidence, and report relationships should remain navigable.
- The UI should support the field workflow first, with administration and analysis connected to the same records rather than separate invented data.

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
