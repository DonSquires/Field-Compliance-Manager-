> **Canonical copy.** Origin: GitLab `don-squires1/field-compliance-manager` `` @ `Main`, read 2026-09-14 via `scripts/gitlab-read.mjs`. This repository (`DonSquires/Field-Compliance-Manager-` `main`) is the authoritative home from now on; the GitLab text is lineage. Edit here and record the ruling — never fork the text. Links to files that do not exist in this repo refer to that lineage.

# FieldOps Manager — Product Design Document

**Version:** 1.0  
**Date:** 2026-06-27  
**Owner:** Don Squires / Iron Eagle Security  
**Status:** Canonical — all build sessions must read this before touching UI code

> This document is the single source of truth for all design decisions.  
> If code conflicts with this document, the code is wrong.

---

## 1. Design Philosophy

### Owner ruling 2026-10-28: service-provider task-first workspaces

R&M's daily operation is the reference workflow, not a separate product or a
hard-coded tenant mode. Replace the mandatory client setup stages with one
client page: organisation text fields, explicit confirmation of the provider's
engagement, and an Add location action above selectable location rows.
Contacts, prices, scheduling and portal invitations may be completed later.
Saving an engagement is an administrator's attestation, not a client signature
or acceptance of a portal invitation.

Each location opens one editable profile. Scheduling, reporting, maps and
specialist controls are contextual destinations from that profile, not extra
steps required to save its basic identity. Keep the selected client and place
when moving between those destinations. Use ordinary operational labels;
"house", "facet" and database identifiers belong in technical detail.

Officers and admin officers can select, create and verify a place from the
officer portal. A map preview and explicit confirmation records a named 10 m
point zone, its client, actor, timestamp, original GPS accuracy and any manual
correction. A point confirmation is not verification of an entire property
perimeter. Existing boundaries remain intact and administrators can refine the
record later. The location and geofence canon define the geometry semantics.

Simplification does not remove tenant isolation, NZTA purpose controls, safety
actions, historical evidence, contract/pricing authority or audit receipts.
Review the three portals and their navigation against these tasks; a source
review or a mocked browser test is not a completed live application audit.

This is a **tactical operations platform**, not a consumer app. Three distinct operating contexts drive every design decision:

| Context | Who | Environment | Priority |
|---------|-----|-------------|----------|
| **Field** | Officers | Outdoors, night, one hand, gloves, urgent | Safety first. Zero ambiguity. |
| **Operations** | Admins, supervisors | Office or vehicle, desktop/tablet | Information density. Speed. |
| **Client** | Council/client contacts | Office, desktop | Professional. Confidence-building. |

**The non-negotiable rule:** Every action an officer takes in the field is potential court evidence. The design must make it impossible to skip steps, easy to capture evidence correctly, and clear about what has been recorded.

---

## 2. Design Tokens

### Universal dark shell ruling — 2026-10-24

All app-managed routes, role shells, dialogs, menus, and pop-outs use the shared
dark design tokens in `apps/web/src/styles/tokens.css`. Admin, client, and
officer layouts remain role-specific; this ruling standardises their visual
language, not their information architecture or safety controls. Page and
component styles should consume semantic tokens rather than define a competing
palette. Status colours retain their meaning, and selected/action states must
keep readable foreground/background pairs. Any future accessibility mode must
be an intentional token override, not an accidental page-level light palette.

Shared page styles and the client portal consume this same palette, including
their pop-out forms, error states and selected period controls. Primary actions
use dark `--color-primary-text` on `--color-primary` (and
`--color-primary-hover` for hover/pressed). Destructive buttons use the separate
`--color-action-danger-*` pair; critical text uses
`--color-status-critical-text` on dark status surfaces. Do not reuse the
critical indicator colour as a small-text foreground or a white-text button.
Keyboard focus must retain at least 3:1 contrast against its adjacent surface:
use the selected-text colour for the pale next-action row and the primary-text
colour for an inset ring on a filled primary button. Off-site safety advice
and active welfare telemetry use the critical-text foreground, not the darker
critical indicator colour.
Number plates deliberately retain a light background and dark text through
`--color-plate-*`; photo shading uses `--color-photo-shade` to preserve evidence
legibility. These are semantic exceptions, not alternative page themes.

Migration is incremental: shared page styles and the client portal have no
local colour literals, but independent legacy stylesheets still need migration.
Token guards and desktop/mobile fixture checks verify contrast, token
inheritance, navigation, selected states and modal workflows. Fixture results
do not establish live persistence, production role coverage or a completed
app-wide visual audit.

### Operations console ruling — 2026-10-19 (owner approved)

The admin operations console uses a viewport-locked hairline-grid workbench:
40px telemetry header, 36px place context, compact navigation, and independently
scrolling data panes. On small screens, explicit pane switching preserves readable
content and touch targets without window scrolling. Operational primary actions
and active navigation use slate/navy, not decorative red. Red denotes an actual
breach, safety alarm, or error; amber denotes warning, emerald active/compliant,
and slate neutral telemetry. Plates, identifiers and timestamps use monospace
tabular numerals. These scoped console tokens supersede the original red-primary
and floating-card guidance below for admin operations only; officer safety/PTT
and client branding are unchanged. Readiness, approvals and assignments still
require their existing governed writers and permission checks.

The same owner-approved slice consolidates CRM into a client/location
master-detail matrix, rather than competing account-flow navigation and
duplicate organisation lists. “Parent” describes the selected client portfolio
and its service locations, not provider ownership of a client organisation.
Commercial and operational settings retain their separate governed sources:
an inline matrix must not turn a draft rate into accepted pricing or silently
disable an agreement-wide module when one location is unchecked. Bob quick-fill
produces reviewable drafts with source context; it never authorises a contract,
geofence, rate, invitation, or live service change.

Finance uses one active-period/KPI ribbon and a workflow switcher: only the
selected ledger or tool occupies the work pane. Rostering uses an officer
directory beside a dense assignment matrix and inline timesheet reconciliation.
Neither presentation changes financial approvals, roster publication checks,
licence evidence, or the organisation/branch scope of its existing writers.

The original console action pairs (white on cobalt, light text on slate) are
superseded by the universal dark ruling above. Reports and investigation actions
must use the same shared action pairs as other app-managed routes.

All values come from `apps/web/src/styles/tokens.css`. Never hardcode colours or spacing in components.

### 2.1 Colour Palette

| Token | Value | Usage |
|-------|-------|-------|
| `--color-bg-base` | `#07131B` | Global page background |
| `--color-bg-surface` | `#0C202B` | Shells, cards, panels, modals |
| `--color-bg-elevated` | `#112C3A` | Controls, dropdowns, elevated surfaces |
| `--color-brand-primary` | `#14C8D4` | Primary actions and active navigation |
| `--color-brand-hover` | `#0BA5B8` | Hover/pressed on primary actions |
| `--color-accent-silver` | `#9BB1BF` | Borders, inactive icons, standby states |
| `--color-accent-silver-light` | `#D4E0E6` | Secondary labels and helper text |
| `--color-text-primary` | `#F5F9FB` | Primary body text and headings |
| `--color-text-secondary` | `#B8CAD4` | Secondary text, table data, metadata |

### 2.2 Status Scale

Always paired with text + icon. Never colour alone.

| Token | Value | Label | Icon | When to use |
|-------|-------|-------|------|-------------|
| `--color-status-normal` | `#4CC38A` | Normal | 🟢 | All clear, compliant, on time |
| `--color-status-watch` | `#F2BF3A` | Watch | 🟡 | Approaching threshold, monitor |
| `--color-status-action` | `#EF9B37` | Action | 🟠 | Needs attention soon |
| `--color-status-critical` | `#D85050` | Critical | 🔴 | Immediate action required |

### 2.3 Reserved Colours

| Token | Value | Reserved for |
|-------|-------|-------------|
| `--color-critical-alert` | `#D85050` | Armed Danger + Welfare Man-Down ONLY |
| `--color-critical-border` | `#F08080` | Pulsing viewport border during Armed Danger ONLY |

Do NOT use these for general errors or warnings.

### 2.4 Typography

| Role | Size | Weight | Token |
|------|------|--------|-------|
| Page heading | 22px | 700 | — |
| Section heading | 18px | 600 | `--font-size-heading` |
| Body text | 15px | 400 | `--font-size-body` |
| Labels / metadata | 13px | 400–600 | `--font-size-label` |
| Kicker / uppercase label | 11px | 700 | — |
| Font family | IBM Plex Sans, Aptos, Segoe UI, sans-serif | — | `--font-family` |

### 2.5 Spacing

| Token | Value | Use |
|-------|-------|-----|
| `--spacing-1` | 4px | Tight gaps between related elements |
| `--spacing-2` | 8px | Icon-to-label gaps, badge padding |
| `--spacing-3` | 12px | Card internal padding (compact) |
| `--spacing-4` | 16px | Standard padding, section gaps |
| `--spacing-6` | 24px | Page padding, major section gaps |
| `--spacing-8` | 32px | Page-level breathing room |

### 2.6 Border Radius

| Token | Value | Use |
|-------|-------|-----|
| `--radius-sm` | 4px | Badges, chips, small buttons |
| `--radius-md` | 8px | Cards, inputs, standard buttons |
| `--radius-lg` | 12px | Modals, drawers, large panels |

### 2.7 Touch Targets

| Context | Minimum | Token |
|---------|---------|-------|
| Officer shell (glove-safe) | 44×44px | `--touch-target-officer` |
| Admin shell | 32×32px | `--touch-target-admin` |

### 2.8 Motion

- Transitions: `0.15s ease` for colour/border changes
- Slide-in drawers: `0.2s ease-out` from right or bottom
- Skeleton shimmer: `1.5s linear infinite`
- All animations must respect `prefers-reduced-motion` — fall back to instant
- Armed Danger pulse: `0.8s` cycle, falls back to static border

---

## 3. Shell Architecture

Three distinct shells. Each is optimised for its context.

**Branding rule:** every shell's top bar / sidebar brand mark is the real
Iron Eagle Security logo image (the same asset used on the login, loading,
and auth-callback screens) — never a plain-text "IE" substitute. This
applies at every viewport, including collapsed/mobile chrome, so the brand
is consistent everywhere it appears.

### 3.1 Officer Shell

**Who:** Field officers (`officer` role)  
**Density:** Glove-safe. Single column. Large targets.  
**Chrome:**

```
┌─────────────────────────────────────────────────────────┐
│  FIELD SAFETY BAR (52px, always visible)              │
│  [Status dot] Name  Timer        [Check In] [SOS]    │
├─────────────────────────────────────────────────────────┤
│  MODULE HEADER (48px, when inside a module)           │
│  [← Home]  [Module icon + name]  [Zone name]          │
├─────────────────────────────────────────────────────────┤
│                                                       │
│  CONTENT AREA (scrollable)                            │
│                                                       │
├─────────────────────────────────────────────────────────┤
│  PTT BAR (64px, always visible)                       │
│  Ch: Alpha 1        [████ HOLD TO TALK ████]          │
└─────────────────────────────────────────────────────────┘
```

**Rules:**
- Field Safety Bar and PTT Bar are ALWAYS visible. Never hidden.
- No horizontal scrolling ever.
- One primary action per screen. Full-width, `--color-brand-primary`.
- Back navigation always available when inside a module.

### 3.2 Admin Shell

**Who:** Admin, master, grand_master, admin_officer
**Density:** Standard (desktop), compact on tablet  
**Chrome:**

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ SIDEBAR (220px / 68px collapsed)  │  TOP BAR (56px)                    │
│ [Logo]                            │  [Org name]    [🔔] [Role] [Name]  │
│ ────────────────────────────────── ├───────────────────────────────────────────────────────────────────────────────┤
│ OPERATIONS                        │                                    │
│   • Dashboard                     │  PAGE CONTENT                      │
│   • Dispatch                      │  (scrollable)                      │
│   • Roster                        │                                    │
│   • Live Map                      │                                    │
│   • Welfare                       │                                    │
│   • Staff                         │                                    │
│ ────────────────────────────────── │                                    │
│ COMPLIANCE                        │                                    │
│   • Breach Review                 │                                    │
│   • Disputes                      │                                    │
│   • Enforcement                   │                                    │
│ ────────────────────────────────── │                                    │
│ FIELD MODULES                     │                                    │
│ SCHEDULING                        │                                    │
│ FINANCE                           │                                    │
│ CONFIG                            │                                    │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Sidebar navigation groups (canonical order):**
1. OPERATIONS: Dashboard, Dispatch, Roster, Live Map, Welfare, Staff, Training, Assets
2. COMPLIANCE: Breach Review, Disputes, Overnight Queue, Enforcement, Compliance, Vehicle Search
3. FIELD MODULES: FC Patrol, Parking, Noise Control, Biosecurity, Smoke Control
4. SCHEDULING: Shift Templates, Patrol Routes, Leave, Timesheets, Callouts, On-Call Pay
5. FINANCE: Invoicing, Payments, Generate Invoice, Tenders
6. REPORTS: FC Reports, Field Reports, SCV Import
7. CONFIG: Locations, Users, Org Setup

**Rules:**
- No duplicate nav items.
- Testing/Test Data are dev-only — hidden in production.
- Bob AI button: fixed bottom-right, 56px circle.
- Mobile: bottom tab bar with 5 items (Home, Dispatch, Roster, CRM, Map) + hamburger for full nav.

### 3.3 Client Shell

**Who:** client_viewer, client_officer, client_admin  
**Density:** Standard. Professional. Read-mostly.  
**Sidebar sections:** Overview, Operations, Enforcement, Records, Reports, Support

### 3.4 NZSCV Supplier Portal

**Owner ruling 2026-09-26.** `nzscv_monitor` is not a mainstream administrator role. It belongs to the external company that supplies the New Zealand self-containment register.

- The role lands on a dedicated read-only supplier transparency page, not the Admin shell.
- The page may show the public certificate register, source/import health, and aggregate analytics describing how the register supports Freedom Camping lookups.
- It must not expose client, officer, incident, location, photo, or raw source-row details.
- It has no enforcement, dispatch, roster, HR, finance, or general administration controls.
- `grand_master` may open the same supplier view for platform support and oversight.
- The NZSCV register remains lookup data for the Freedom Camping module; it is not a standalone operational module.

---

## 4. Officer Entry State Machine

Every officer login resolves to one of four states. This is determined at login and re-checked on every app focus.

```
Officer logs in
       │
       ├── module_access is set (admin-granted direct access)?
       │         │
       │         ├── Only 1 module → go directly to that module portal
       │         └── Multiple modules → MODULE SELECTOR SCREEN
       │
       ├── Active shift right now OR starting within 15 min?
       │         └── YES → OFFICER HOME (roster-first)
       │
       └── No shift, no direct access
                 └── WELFARE STANDBY SCREEN
```

### State 1: Welfare Standby
- Shows: officer photo, name, org, "No shift assigned" message
- Shows: open shifts available to accept/decline
- Auto-refreshes every 30 seconds (silent)
- Access: Emergency SOS + welfare check-in only
- PTT: SOS-only channel

### State 2: Officer Home (Roster-First)
- Shows: active shift card (dominant, full-width, red CTA)
- Shows: upcoming shifts this week (read-only)
- Shows: open shifts to accept/decline
- Greeting uses time of day (Good morning/afternoon/evening)
- One primary action: [Enter Patrol Portal] — full width, red

### State 3: Module Selector
- Shows: only modules granted by admin
- Large cards (min 120×120px), glove-safe
- If only 1 module granted: skip this screen, go directly in
- No roster required

### State 4: Module Portal
- Module header shows: [← Home] [Module icon + name] [Zone]
- Field Safety Bar always at top
- PTT Bar always at bottom
- Back arrow always returns to State 2 or State 3

---

## 5. Page Anatomy

Every admin page follows this structure top to bottom:

```
┌─────────────────────────────────────────────────────────┐
│  PAGE HEADER                                         │
│  [Kicker / breadcrumb]                               │
│  Page Title (22px bold)          [Primary Action]    │
│  Subtitle (13px silver)                              │
├─────────────────────────────────────────────────────────┤
│  STATUS STRIP (only when live data warrants it)      │
│  [Status badge] [Status badge] [Status badge]        │
├─────────────────────────────────────────────────────────┤
│  FILTERS / SEARCH (when applicable)                  │
├─────────────────────────────────────────────────────────┤
│  CONTENT AREA                                        │
│  (table / cards / map / form)                        │
├─────────────────────────────────────────────────────────┤
│  AUDIT TRACE (detail pages only)                     │
│  Last modified by [name] at [timestamp]              │
└─────────────────────────────────────────────────────────┘
```

**Rules:**
- ONE primary action per page. Always top-right. Always `--color-brand-primary`.
- Status strip only appears when there is live data to show. Zero state = hidden.
- Kicker text: 11px, uppercase, `--color-brand-primary`, letter-spacing 2px.

---

## 6. Component Library

### 6.1 KPI Tile

Used on dashboards and hub pages.

```
┌────────────────────────┐
│  🚨  Breaches          │
│  12                    │  ← Number: 32px bold, colour by severity
│  CRITICAL              │  ← Status label: 10px uppercase
└────────────────────────┘
```

- Clickable — navigates to the relevant page
- Border colour matches status (normal/watch/action/critical)
- Zero state: number is white, no status label

### 6.2 Workflow Card

Used in queues (breach queue, dispatch queue, dispute queue).

```
┌─────────────────────────────────────────────────────────┐
│  [Icon]  Title                        [Status badge]  │
│  Subtitle / metadata (13px silver)                    │
│  ─────────────────────────────────────────────────────  │
│  Key data                                             │
│  ─────────────────────────────────────────────────────  │
│  [Secondary action]          [Primary action]         │
└─────────────────────────────────────────────────────────┘
```

- Max 2 actions per card footer
- Primary action: `--color-brand-primary` background
- Secondary action: transparent with border

### 6.3 Empty State

Every list page must have an empty state with a call to action.

```
┌───────────────────────────────────────────────┐
│                                               │
│           [Relevant icon, 40px]               │
│        No breaches to review                  │  ← 18px, white
│   All zones are currently compliant.          │  ← 14px, silver
│                                               │
│         [View Compliance →]                   │  ← Always a CTA
│                                               │
└───────────────────────────────────────────────┘
```

### 6.4 Skeleton Loading State

Every data-loading page shows a skeleton, not a spinner.

```
┌───────────────────────────────────────────────┐
│  ██████████████████  ████████             │  ← shimmer
│  ████████████████████████████████       │
│  ████████████  ████████████████       │
└───────────────────────────────────────────────┘
```

- Background: `--color-bg-elevated`
- Shimmer: linear-gradient animation, `1.5s linear infinite`
- Shape matches the content being loaded

### 6.5 Status Badge

Always text + colour. Never colour alone.

```
[🟢 Normal]  [🟡 Watch]  [🟠 Action]  [🔴 Critical]
```

- Border-radius: `--radius-sm`
- Font: 11px, 700 weight, uppercase
- Background: status colour at 15% opacity
- Border: status colour at 40% opacity

### 6.6 Drawer / Slide-Over

Used for detail panels, forms, and confirmations.

- Slides in from the right on desktop (width: 420–480px)
- Slides up from the bottom on mobile (full width, 80% height)
- Backdrop: `rgba(0,0,0,0.7)`
- Close button: top-right, 44×44px minimum
- Always has a header with title + close button
- Scrollable body
- Sticky footer with action buttons

### 6.6b Full-Screen Detail Sheet (mobile list → detail)

Used for deep, tabbed record views reached by selecting a row in a list
(CRM accounts, Sites, Staff, and other selection-driven admin pages).
Distinct from 6.6 Drawer/Slide-Over, which is for confirmations and quick
edits — a record with several tabs of content deserves the whole screen,
not a partial drawer.

- Desktop: unchanged — the existing inline detail pane next to the list.
- Mobile: full-screen (`inset: 0`), no dimming backdrop (it fully replaces
  the view), safe-area aware, own scroll.
- The wrapped content keeps owning its header/close control — the sheet
  only supplies positioning, scroll, and entrance motion.
- One shared implementation: `components/responsive/MobileDetailSheet.tsx`.
  Do not hand-roll a per-page copy of these overlay styles.
- Entrance: subtle slide-up + fade, `0.2s ease-out`, respects
  `prefers-reduced-motion`.

### 6.7 Confirmation Bottom Sheet (Officer)

Used for accept/decline shift, SOS confirmation, notice issuance.

```
┌───────────────────────────────────────────────┐
│  ─────────────────────────────────────────────  │  ← drag handle
│  Accept this shift?                           │
│  FC Patrol · Tonight 20:00–06:00             │
│                                               │
│  [        Confirm Accept        ]             │  ← full width, green
│  [             Cancel           ]             │  ← full width, ghost
└───────────────────────────────────────────────┘
```

- Slides up from bottom
- Rounded top corners: 16px
- Buttons: min 56px height (glove-safe)
- Destructive actions: red background
- Confirm actions: green background
- Cancel: ghost (transparent + border)

---

## 7. Court-Readiness Design Requirements

These are non-negotiable. Every enforcement action must be legally defensible.

### 7.1 Evidence Chain of Custody

Every photo captured in the field must display and store:
- GPS coordinates (lat/lng + accuracy in metres)
- Timestamp (ISO 8601, NZ timezone)
- Officer ID and display name
- Device identifier
- Module context (which module captured it)
- Record ID it is linked to

The UI must show a small metadata strip below every evidence photo:
```
📍 -41.2865, 174.7762 (±3m)  ⏰ 27 Jun 2026 21:34:17 NZST  👤 Jane Smith
```

### 7.2 Human Fire-Control Key

Before any notice prints, the officer must:
1. See a preview of the notice
2. Type their full name in a signature field
3. Click [Authorize Print]

The print button is disabled until the name matches their profile name. This is enforced in the UI and logged server-side.

### 7.3 Enforcement Decision Path

The UI must enforce the correct decision sequence. Officers cannot skip steps:

```
First offence → Warning only (cannot issue infringement)
Prior warning → Can issue infringement
Prior infringement → Can issue NTV or escalate
```

If an officer tries to skip a step, the UI shows:
```
⚠️ A warning must be issued before an infringement notice.
    [Issue Warning Instead]  [Cancel]
```

### 7.4 Pre-Arrival Safety Dossier

Before issuing a Notice to Vacate, the officer sees a mandatory dossier:

```
┌───────────────────────────────────────────────┐
│  📊 Pre-Arrival Safety Dossier — Last 24h       │
│  Zone: Nelson Riverside                       │
│                                               │
│  Observations: 14    Incidents: 2             │
│  Welfare alerts: 0   Aggression signals: 1    │
│                                               │
│  Risk level: 🟠 MEDIUM                         │
│  Approach with caution. Prior friction noted. │
│                                               │
│  [I have reviewed this]  [Cancel]             │
└───────────────────────────────────────────────┘
```

Officer must tap [I have reviewed this] before proceeding. This is logged.

### 7.5 Audit Trace Footer

Every detail page (notice, breach, incident, observation) must show:
```
Created by Jane Smith · 27 Jun 2026 21:34 NZST
Last modified by Admin Don · 28 Jun 2026 09:12 NZST
Record ID: INF-20260627-0042
```

---

## 8. Accessibility Standards

Minimum: WCAG 2.2 AA across all shells.

| Requirement | Rule |
|-------------|------|
| Focus visibility | Keyboard focus indicator never obscured |
| Touch targets | ≥44×44px in officer shell, ≥24×24px in admin shell |
| Colour + text | Every status uses icon + text, never colour alone |
| Reduced motion | All animations respect `prefers-reduced-motion` |
| Screen reader | All icons have `aria-label`. All forms have `<label>`. |
| Error messages | Always describe what went wrong AND what to do next |
| Loading states | `aria-busy="true"` on loading containers |
| Drag alternatives | Every drag action has a click alternative |

---

## 9. Admin Hub Redesign Specification

The current hub is a flat grid of 19 equal-weight cards. This violates the one-primary-action rule. The redesigned hub has clear hierarchy:

**Section 1: Live KPI Strip (4 tiles)**
- Breaches (red if >0)
- Active Patrols (blue)
- Welfare Alerts (amber if >0)
- Scans Today (green)

**Section 2: Priority Actions (only shown when urgent)**
- One card per urgent item, full width, with direct action button
- Zero state: section is hidden entirely

**Section 3: Quick Navigation (grouped)**
- Operations: Dispatch, Roster, Live Map, Welfare, Staff
- Compliance: Breaches, Disputes, Enforcement, Compliance
- Finance: Invoicing, Payments
- Modules: Parking, Noise, Biosecurity, Smoke

---

## 10. Module Access Admin UI

In User Management, each officer profile gets a Module Access section:

```
Module Access (Direct — no roster required)
┌─────────────────────────────────────────────────────────────────┐
│  [✅ 🅿️ Parking]  [☐ 🔊 Noise]  [☐ 🏕️ FC Patrol]  [☐ 🦠 Biosecurity]  │
│  [☐ 💨 Smoke]   [☐ 🛡️ Site Guard]  [☐ 📡 EMS]                    │
│                                                               │
│  ⚠️ Direct access bypasses the roster gate.                    │
│     Only grant to permanently assigned officers.              │
└─────────────────────────────────────────────────────────────────┘
```

---

## 11. Build Order for Design Implementation

Implement in this order. Each item is one focused build session.

1. **tokens.css** — add missing tokens (motion, shimmer, elevation shadows)
2. **OfficerShell** — implement the 4-state entry machine
3. **Officer Home screen** — roster-first with open shifts
4. **Module Selector screen** — admin-granted direct access
5. **Welfare Standby screen** — no shift state
6. **AdminHub redesign** — KPI strip + priority actions + grouped nav
7. **AdminShell sidebar** — fix grouping, remove duplicates
8. **Module Access UI** — in UserManagementPage
9. **Auth Callback page** — set password + expired token handling
10. **Skeleton loading** — add to all data-loading pages
11. **Empty states** — add to all list pages
12. **Court-readiness** — fire-control key, pre-arrival dossier, evidence metadata
