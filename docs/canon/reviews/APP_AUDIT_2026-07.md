> **Canonical copy.** Origin: GitLab `don-squires1/field-compliance-manager` `` @ `Main`, read 2026-09-14 via `scripts/gitlab-read.mjs`. This repository (`DonSquires/Field-Compliance-Manager-` `main`) is the authoritative home from now on; the GitLab text is lineage. Edit here and record the ruling — never fork the text. Links to files that do not exist in this repo refer to that lineage.

# App Audit — 2026-07 (UI/UX · Wiring · Bob integration)

**Method:** center -> perimeter, top layer -> nuts & bolts. Each module is scored on
FIVE lenses:
1. **UI/UX** — the surface a user touches (live data vs phantom, mobile, states, reachable).
2. **Wiring/Pipeline** — tables/columns/FKs/data-flow; canonical vs deprecated.
3. **Bob integration** — context-aware, tools, knowledge.
4. **Competitive** — what it DOES vs a best-in-class equivalent (from implementation, not marketing): gaps + where our NZ-compliance / AI-native / multi-module angle wins.
5. **Modularity** — can it run STANDALONE and INTEGRATED, and are the SYSTEMS in place (module enablement, manifest, spine-only seams, graceful degradation when siblings are off).

Legend: 🟢 solid · 🟠 gaps · 🔴 broken.

> **PROCESS RULE (learned): FINISH THE AUDIT before fixing/building.** The previous
> app audit was abandoned partway to start building — which is exactly why #7/#8/#9
> (locations retirement + UI reconciliation) are half-done today. Complete ALL rings
> first, THEN prioritise fixes against the full picture. Do not fix mid-audit.

> Repo-code review. Items marked **(verify-live)** need a live SQL/schema check
> because the repo migrations lag the live DB (a known project rule).

## Rings
1. **Center:** Org/entity model, CRM, Locations, Org Setup. ← *this batch*
2. **Ring 2:** Dispatch, Roster, Staff, Credentials.
3. **Ring 3:** FC Patrol, Compliance, Breach Review, Notice Print, Field Reports, Welfare, Live Map.
4. **Perimeter:** SCV Import, NZSCV Monitor, Vehicle Search, Invoicing, FC Reports.

---

## Cross-cutting (affects every module)

### Modularity infrastructure — 🟢 strong (the system enabling standalone+integrated)
- **`packages/shared/moduleManifest.ts`** is a genuine, well-designed registry: each module declares `sellable` (standalone-capable), `adminPages`, `officerModule`, `settingsPages`, `tables`, `reportSlice`, and — crucially — **`requiresSpines`** (the shared platform it needs: org_site_setup, users_roles, geofence_zones, dispatch_roster, evidence_capture, reporting, invoicing, bob).
- `requiresSpines` IS the "systems in place to make standalone+integrated happen": a module runs STANDALONE because its spines are always present for every org, and INTEGRATED because it shares that one spine. Gating (`organization_modules` + `useEnabledModules`), reporting slices, and the pricing catalog all read this ONE registry.
- 🟠 To verify per-module below: (a) manifest `tables` stay aligned with LIVE schema (the file warns this); (b) each module degrades gracefully when a sibling is OFF (no hard cross-module coupling); (c) `sellable` modules truly work with ONLY their spines (the "standalone Freedom Camping mode" claim).

### Bob integration wiring — 🟢 solid (foundation)
- `AdminShell` defines `PAGE_CONTEXT: Record<AdminPage, BobContext>` mapping EVERY page to `{ page, module }`, and passes it into `<BobPanel context=... />`. So Bob is **portal/module-aware on every module for free** — he knows where you are. Good architecture.
- GAP 🟠: the context is only `{page, module}` (location awareness). It does NOT pass the active record (e.g. the open client/site id) so Bob can't yet auto-scope to "this client" without being told. Recommendation: extend `BobContext` per page with `site_id`/`org_id`/`record_id` when a detail is open (the type already has `site_id`, `site_name`, `extra`), and populate it from the detail pages. Low effort, high value for "add a note to THIS client".

### Post-!615 chat UI — 🟢 (verify on device)
- Persist/history/copy/feedback/markdown/textarea live; mobile close reachable. Confirm on a hard-refreshed PWA (stale cache risk).

---

## CENTER

### CRM (`CRMPage.tsx`, 2620 lines) — 🟢 UI / 🟢 Wiring / 🟠 Bob

**UI/UX — 🟢**
- Live list with tabs (Clients/Providers/Branches/Contractors/Organisations/All), search (name/contact/email), table + cards view, roles/linking explainer, `+ Add Account` + `Start Onboarding` (ClientOnboardingWizard). Role-gated create: grand_master = top-level, master = under-provider. Card/table mobile pass done earlier (!430-range).
- 🟠 Watch: 2620 lines in one file — a maintenance risk (STAGING flagged this re: the agreement form). Candidate for a later split, not urgent.

**Wiring/Pipeline — 🟢 (canonical, correct)**
- Reads `organizations` (id, name, organization_type, organization_level, parent_organization_id, active, contact_email, contact_phone) filtered to the real type set. ✅ matches canonical model.
- Site counts via `client_sites.client_organization_id` ✅ (correct ownership column — NOT organization_id).
- Primary contact via `crm_contacts` (organization_id, is_primary). Sites via `client_sites`; agreements via `service_agreements` (provider/client org ids); commercial via `crm_commercial_settings`; activity via `crm_activity_log`.
- This is the app's CENTER and the wiring is consistent with `app_entity_model`. Bob's engineering cards (0121/0123) describe exactly this pipeline. ✅
- **(verify-live)** confirm `crm_commercial_settings` columns (billing_cycle, payment_terms_days, base_rate_per_hour, callout_rate_per_hour) match live — finance tables were the phantom-column hotspot (STAGING batch-1/2 audit).

**Bob integration — 🟠 (aware, not yet acting here)**
- Bob IS context-aware on CRM (`{page:'CRM', module:'crm'}`) and now has the knowledge to reason about org->client->site.
- GAP: the "create client from source data" flow (the whole !616 thrust) PROPOSES via reasoning, but the governed CREATE (org + site parent-first) execute-on-approval path is **not yet exercised end-to-end** (see STAGING PM2 outstanding #2). CRM is where that must be proven.
- Recommendation: pass the open client's `org_id` in `BobContext` so "add a contact / add a site to this client" scopes automatically.

**Competitive (vs Zoho CRM / HubSpot) — 🟠**
- HAS: hierarchical accounts (owner/provider/branch/client), contacts (primary/emergency), sites, service agreements + commercial settings, activity log, onboarding wizard — a credible industry-specific CRM core.
- GAPS vs Zoho/HubSpot: no deal/pipeline stages (tenders are separate), no email/comms integration or click-to-log, follow-ups in `crm_activity_log.follow_up_at` not surfaced as tasks/reminders, no in-CRM dashboards. Most aren't needed for a security-ops CRM — note, don't over-build.
- ADVANTAGE (moat): the CRM is wired to OPERATIONS (sites->patrols->compliance->invoicing) and AI-native (Bob onboards from documents). No generic CRM delivers field-compliance. Lean into onboarding-from-docs + SLA/obligation linkage, not generic parity.

**Modularity — 🟢** — CRM maps to the `org_site_setup` + `users_roles` SPINES (always-on core; `sellable` n/a). It IS the shared spine other modules build on — correctly foundational.

### Organizations / entity model (schema) — 🟢
- owner -> service_provider -> branch -> client/gov/private/contractor via `parent_organization_id` (+ `organization_level` trigger). `client_sites` owned by `client_organization_id`. This is the spine every module references; verified consistent across CRM reads.
- Current live data (from the NOC/CRM header): 1 provider, 10 branches, 0 clients, 12 orgs total — i.e. the backbone exists, the CLIENT layer is empty (expected after the 0109 reset). The FS Nelson import is meant to populate it.

### Locations (`LocationsPage.tsx`, 1033 lines) — 🟢 UI / 🔴 Wiring / 🟠 Bob / 🟠 Competitive / 🟠 Modularity

**UI/UX — 🟢** — rich: location + zones, boundary editor (Leaflet), rules (nightly limits/SCV/bylaw/enforcement-override 0066/repeat-stay 0059), signage evidence, closures (0058), child-zone picker, mobile pass.

**Wiring — 🔴 BROKEN (deprecated table — KNOWN/deferred, not a surprise).** Reads/writes **`.from('locations')`**. Precise history (STAGING): `locations` was TRUNCATED + deprecated; the canonical model is `client_sites` (Site) + `location_zones` (Zone) siblings. Retiring `locations` was tracked as **#7** and FOLDED INTO **#9** ("repoint incidents/person_interactions, retire *_flags, drop locations in one pass"). #9 PARTIALLY shipped (0113/0114 entity-intelligence model) — but the **`locations` DROP + the UI repoint (#8) did NOT complete**. #8 explicitly says: "`LocationsPage` + `PatrolCheckpointsPage` on deprecated `locations` (🔴)... Do AFTER #9 settles the DB." So this is a **known, tracked, deferred** item, not new rot. Impact unchanged: this surface is disconnected from the canonical pipeline; likely stale/empty post-0109; zones may not attach to real `client_sites`.
- **(verify-live)** before any fix: `select to_regclass('public.locations')` (does it still exist?) + what still FK-references it (`incidents.location_id`, `person_interactions.location_id`, `vehicle_flags.location_id`, `patrol_checkpoints.location_id`, `location_zones`?). That tells us how much of #9's drop actually happened.
- **Fix (Ring-1, part of finishing #7/#8/#9):** repoint LocationsPage + PatrolCheckpoints to `client_sites`+`location_zones`, repoint the remaining anchors, then drop `locations`.

**Bob — 🟠** — context-aware, but Bob's `app_entity_model` (client_sites/location_zones) does NOT match this UI; fixing the wiring fixes the mismatch.

**Competitive (vs TrackTik/PremierOne geofencing) — 🟠** — strong geofence config (schedules, child zones, closures, repeat-stay, NZ bylaw refs) that generic tools lack; undermined by the deprecated-table wiring. Fix that before claiming parity.

**Modularity — 🟠** — maps to the `geofence_zones` SPINE (shared, always-on). A spine on a deprecated table is a shaky foundation for EVERY module that geofences; fixing the wiring is also a modularity fix.

### Org Setup (`OrganizationSetupPage.tsx`, 483 lines) — 🟢 UI / 🟢 Wiring / 🟢 Bob / n-a Competitive / 🟢 Modularity
- **UI/Wiring/Bob 🟢:** org profile + per-org module enablement + child orgs + jurisdiction/enforcement config on `organizations`; Bob-as-proposer governance (`BOB_SYSTEM_USER_ID`).
- **Modularity 🟢:** THIS PAGE IS the module-enablement control plane — the `organization_modules` gate turning the manifest's `sellable` modules on/off per org. The operator's half of the standalone+integrated system. Solid.

**CENTER VERDICT:** org spine + CRM + Org Setup 🟢 canonical; modularity system (manifest + org module gating) 🟢 strong. The one real rot is **Locations on the deprecated `locations` table (🔴)** — highest-value center fix; it also weakens the geofence spine for every module.

---

## Prioritised fixes (running)
1. **(Ring-1, HIGH)** Repoint **LocationsPage off the deprecated `locations` table** to canonical `client_sites` + `location_zones`. Center's one broken pipeline + weakens the geofence spine. (verify-live shape first.)
2. **(Ring-1, HIGH)** Prove the governed CREATE path end-to-end in CRM (org+site parent-first, execute-on-approval). Blocks "Bob working".
3. **(Cross-cutting, medium)** Extend `BobContext` to carry the open record id (org/site) so Bob scopes to "this" entity.
4. **(verify-live, low)** Confirm `crm_commercial_settings` columns vs live schema.
5. **(tech-debt, low)** Consider splitting the 2620-line `CRMPage.tsx`.

---

## RING 2 — OPERATIONAL CORE (Dispatch, Roster, Staff, Credentials)

> Overall: MATURE ("core complete" in STAGING). Live data, good structure, no deprecated-table
> rot found. Main theme is Bob DEPTH (aware but few operational tools) + known finance/pay gaps.

### Dispatch (`DispatchConsolePage.tsx` 855 + `DispatchResourcesPage`) — 🟢 UI / 🟢 Wiring / 🟠 Bob / 🟢 Competitive / 🟢 Modularity
- **UI 🟢** active-shifts panel + live SLA health, ordered stops + ETAs, adhoc job with **SLA impact preview** before confirm, job queue, nearest-unit. CAD-grade.
- **Wiring 🟢** shifts/shift_stops/dispatch_jobs/dispatch_resources + `sla_clocks` (0060/0061); `/api/patrol/insert-adhoc` (OSRM/solver); SiteQuickCreate on `client_sites`. Canonical.
- **Bob 🟠** context-aware; no dispatch tool yet (can't propose/triage a dispatch). Future: read-only "nearest unit / flag SLA risk".
- **Competitive (vs Motorola PremierOne CAD) 🟢** dispatch-to-callsign, CAD lifecycle (ack->en_route->on_scene->complete), SLA clocks, nearest-unit. Gaps (deferred/tracked): Dispatch Wizard, read-only Monitor, job-linked chat. Advantage: SLA/obligation + patrol-route integration.
- **Modularity 🟢** `dispatch_roster` spine.

### Roster (`RosterPage.tsx` 807 + ShiftTemplates) — 🟢 UI / 🟢 Wiring / 🟠 Bob / 🟢 Competitive / 🟢 Modularity
- **UI 🟢** weekly board (officers × days), route-aware shift creation, publish -> generate stops -> OR-Tools optimise, shift-health, **credential warnings per officer**.
- **Wiring 🟢** shifts/shift_stops + patrol_routes; officer picker = branch-authorised ∩ can_be_rostered ∩ work_ready (0074). Canonical.
- **Bob 🟠** aware, no roster tool ("propose a roster / who's credential-safe"). Future copilot value.
- **Competitive (vs Deputy/InTime) 🟢** credential-aware scheduling + route integration is BEYOND generic rostering. Gaps: availability self-service, shift-swap (some officer-side). Advantage: credential-gated + route-optimised.
- **Modularity 🟢** `dispatch_roster` spine.

### Staff (`StaffManagementPage.tsx` 1043) — 🟢 UI / 🟢 Wiring / 🟠 Bob / 🟢 Competitive / 🟢 Modularity
- **UI 🟢** tabs: staff/credentials/documents/skills/availability/leave/assets/authorisations. Comprehensive.
- **Wiring 🟢** staff_profiles (id = user_profiles.id shared PK, 0094/0095), staff_credentials (`staff_id`), staff_branch_authorisations (`branch_org_id`, 0074), assets, leave_requests. Live-verified names (the historic phantom hotspot, fixed in the 0072-0077 audit).
- **Bob 🟠** aware; extract_credential exists but not wired as a Staff-page action. Future: "onboard this officer from their COA/licence photos".
- **Competitive (vs Deputy/InTime HR) 🟢** credential/warrant + authorisations model strong for security ops. Gap: officer pay-rate model deferred (finance).
- **Modularity 🟢** `users_roles` + `dispatch_roster` spines.

### Credentials (`CredentialExpiryPage.tsx` 222) — 🟢 UI / 🟢 Wiring / 🟢 Bob / 🟢 Competitive / 🟢 Modularity
- **UI 🟢** expiry alerts banded 30/14/7/expired; click-through to renew.
- **Wiring 🟢** staff_credentials (`staff_id`); `notify-credential-expiry` (4.2) -> notifications spine (0068/0069).
- **Bob 🟢** alerts flow to the bell; good enough.
- **Competitive 🟢** expiry automation + roster-gating is a real safety feature. Gap: shift-assignment BLOCK on expiry is configurable-but-not-built.
- **Modularity 🟢** part of `users_roles` spine.

**RING 2 VERDICT:** 🟢 mature + canonical, no rot. Consistent gap = **Bob DEPTH** (aware, few operational tools). Known deferred: dispatch wizard/monitor/job-chat; officer pay-rate; shift-block-on-expiry.

### Prioritised additions from Ring 2 (running)
6. **(capability, medium)** Bob operational tools for Dispatch/Roster (read-only first: nearest unit, SLA risk, credential-safe-to-roster).
7. **(gap, low)** Shift-assignment block on expired credential (configurable).

---

## RING 3 — FIELD OPS (Patrol, Compliance, Breach Review, Notice Print, Field Reports, Welfare, Live Map)

> Overall 🟢 mature + canonical (Layer 2 "field ops complete"). No deprecated-table rot in the
> pages sampled. Same theme: Bob is aware but read-only; a couple of anchoring/infra follow-ups.

### FC Patrol (`PatrolPage.tsx` 838) — 🟢 UI / 🟢 Wiring / 🟠 Bob / 🟢 Competitive / 🟢 Modularity
- Full officer field workflow: ordered stops + ETA + SLA countdown, navigate, arrive/complete, adhoc notifications, module action checklist, **camera/ALPR -> process-officer-scan -> verdict**, offline queue (IndexedDB auto-sync), pre-arrival dossier, **human fire-control key** before notice print.
- Wiring 🟢 shift_stops + process-officer-scan pipeline (ALPR/compliance/breach). Competitive (vs TrackTik/Silvertrac) 🟢: ALPR + evidence + SLA + offline is beyond generic patrol; the AI verdict is the edge. Bob 🟠 aware, no in-patrol Bob assist yet (deferred voice/radio-assist). Modularity 🟢 gated per module (freedom_camping/parking).

### Breach Review (`FCBreachReviewPage.tsx` 419) — 🟢 / 🟢 / 🟠 / 🟢 / 🟢
- breach_alerts joined to observations (plate/zone/evidence); status lifecycle open->acknowledged->actioned->dismissed->resolved; two-step confirm; actioned_by/at stamped; notice issuance is a SEPARATE flow (correct separation). Bob 🟠: a read-only "breach triage suggestion" is a deferred 4.1 item — good future copilot fit.

### Field Reports (`FieldReportsAdminPage.tsx` 371 + officer ReportButton) — 🟢 / 🟢 / 🟠 / 🟢 / 🟢
- officer_field_reports (incident/maintenance/health_safety; severity; status; **address** anchoring 0103; gps; follow-up). Admin review/close. Anchored-report foundation (LOI/VOI/POI via ReportButton). Bob 🟠 aware; could summarise/triage reports (future).
- 🟠 known housekeeping (STAGING): retire the legacy free-text OfficerFieldReportPage form (superseded by the anchored ReportButton).

### Welfare (`WelfareAlertsPage.tsx` 358 + WelfareSettings + hooks) — 🟢 / 🟢 / 🟠 / 🟢 / 🟢
- On the CANONICAL `welfare_alerts`/`welfare_checks`/`officer_welfare_settings` (0055; officer_user_id key) — the earlier phantom-table bug (officer_welfare_*) was FIXED (W1-W5). Ack/resolve-with-notes, escalation levels, GPS-stationary man-down, inactivity/gps_lost. HSWA-grade lone-worker suite. Competitive 🟢 strong. Bob 🟠 aware. Modularity 🟢 part of the safety spine. W6 (fall/shake/Bluetooth panic) deferred to Layer 5 mobile.

### Compliance / Notice Print / Live Map — 🟢 (sampled; consistent with the above)
- Compliance = zone RAG cards + dashboard (reads observations/breach; note the deprecated-`locations` risk touches zone geo — see Ring-1 Locations fix). Notice Print = generate-notice edge fn -> print/PDF (warning/NTV/infringement), governed, fire-control-key gated. Live Map = officer GPS (officer_gps_log.created_at — the fixed col) + zones + heatmap.
- 🟠 Compliance/Live Map both render ZONES — their correctness depends on the geofence spine, which is entangled with the deprecated `locations` table (Ring-1 #1). Another reason that fix is high-value.

**RING 3 VERDICT:** 🟢 mature; the field pipeline (scan->verdict->breach->notice, welfare, reports) is real and canonical. Cross-cutting themes reconfirmed: (1) **Bob depth** (aware, few tools) is the biggest opportunity; (2) the **geofence/`locations` spine** (Ring-1 #1) quietly underpins Compliance + Live Map + zone detection — fixing it has ring-wide benefit. Housekeeping: retire legacy field-report form.

---

## PERIMETER — SPECIALIST/EDGE (SCV Import, NZSCV Monitor, Vehicle Search, Invoicing, FC Reports)

### Vehicle Search (`VehicleSearchPage.tsx` 235) — 🟢 / 🟢 / 🟠 / 🟢 / 🟢
- Plate -> observations (verdicts) + breach_alerts + `canonical_scv` status + `canonical_vehicles` attributes. Canonical, clean. Bob 🟠 aware; a "tell me about this plate" Bob tool would be natural (query_records-style). Competitive 🟢: unified scan+breach+SCV history per plate is strong.

### SCV Import (`FCSCVImportPage`) + NZSCV Monitor (`FCNZSCVMonitor`) — 🟢 / 🟢 / 🟢 (SCV import is the RIGHT home for plan_import)
- SCV Import = upload canonical SCV CSV -> `canonical_scv` (governed staging). **This is exactly the narrow "load a clean table" case `plan_import` was demoted TO in !616** — the specialist home is real and appropriate. NZSCV Monitor = SCV status + enforcement countdown via the VPS-static-IP `nzscvProxy`. Modularity 🟢: part of freedom_camping module tables.

### Invoicing — SPLIT maturity: admin 🟢 / GenerateInvoice 🟠 (deliberately disabled)
- **`InvoicingPage.tsx` 🟢** — FIXED onto the LIVE richer `invoices` shape (client_organization_id, total_amount, invoice_date/due_date, status, subtotal/gst) — the earlier phantom-0029 columns are gone; client name derived from `organizations`. Print/PDF + send-invoice (SMTP). Caveat (tracked): admin invoice has no line-items/GST breakdown (that lives on the client shape).
- **`GenerateInvoicePage.tsx` 🟠** — DELIBERATELY DISABLED with an honest notice (not silent breakage). It was broken on 4 tables (phantom `staff_pay_rates`, wrong timesheets/invoices/line-item cols). Live billing is by SERVICE AGREEMENT (`crm_commercial_settings`) / SITE (`site_financial_config`) — the rate-engine tables EXIST (0079/0080); only the BILLING RULE (how agreement vs site rates combine) is an OWNER DECISION, not yet made. Good handling of an undecided feature.
- Competitive (vs Xero-lite) 🟠: invoice tracking + email works; generation-from-work is the gap, blocked on the pricing rule, not the code.
- **(owner decision — NOW CONFIRMED)** billing model = hybrid + billing bureaus + scaled SLA. See "BILLING MODEL (Phase 4 spec)" at the end of this doc. Unblocks GenerateInvoice when built in Phase 4.

### FC Reports (`FCReportingPage`) + Reports Hub — 🟢
- Pre-built reports (compliance/scans, breach, SLA, credentials, VOI) + CSV export + date range. Deferred: custom builder, scheduled email, AI-analysis (Bob).

**PERIMETER VERDICT:** 🟢 solid. Finance is the only amber — and it's a **known owner-decision** (billing rules), not rot. Notably SCV Import validates the !616 `plan_import` demotion (there IS a real clean-table-load home).

---

## FINAL SYNTHESIS & ROADMAP

### Overall health: 🟢 strong, with ONE structural break + consistent capability opportunities
The app is far more mature and canonical than a first look suggests. The org/CRM spine, operational core (Dispatch/Roster/Staff/Credentials), and field ops (Patrol/Breach/Welfare/Reports) are 🟢 and on live-verified schema. The modularity system (`moduleManifest` + `organization_modules`) is genuinely well-built. Bob is context-aware everywhere.

### The findings, by type
**🔴 Structural (the one real break):**
1. **Locations UI on the deprecated `locations` table** (Ring-1). Known/tracked (#7/#8/#9), partially addressed by 0113/0114 but drop+repoint NOT finished. Underpins the geofence spine -> quietly affects Compliance + Live Map + zone detection. **Highest-value fix.** (verify-live: does `locations` still exist, what references it.)

**🟠 Capability opportunities (not defects — the biggest theme):**
2. **Bob DEPTH** — aware on every module, but few operational TOOLS beyond the import/understand path. Highest-value copilot adds (read-only first): Dispatch (nearest unit / SLA risk), Roster (credential-safe rostering), Breach (triage suggestion), Vehicle ("about this plate"), Field Reports (summarise/triage).
3. **Governed CREATE not yet proven end-to-end** (org+site parent-first, execute-on-approval) — the "Bob working" finish line.
4. **BobContext** should carry the open record id (scope to "this client/site").

**🟠 Known owner-decisions / deferred (tracked, not rot):**
5. Billing rules -> unblock GenerateInvoice.
6. Shift-block-on-expired-credential (safety, configurable).
7. Retire legacy free-text field-report form.
8. Dispatch wizard/monitor/job-chat; custom/scheduled/AI reports; W6 mobile welfare sensors.

### Recommended fix roadmap (AFTER this audit, in order)
- **Phase 1 — finish the structural spine:** complete #7/#8/#9 — verify `locations` live, repoint LocationsPage + PatrolCheckpoints to `client_sites`/`location_zones`, repoint remaining anchors, drop `locations`. Unblocks trustworthy zones for Compliance/Live Map/Patrol + Bob.
- **Phase 2 — prove Bob acts:** governed CREATE end-to-end in CRM (client org + site parent-first) + BobContext record-scoping. The FS Nelson graduation test.
- **Phase 3 — Bob copilot depth:** read-only operational tools per module (dispatch/roster/breach/vehicle).
- **Phase 4 — owner-decision items:** billing model (GenerateInvoice), credential shift-block.
- **Phase 5 — deferred polish:** dispatch wizard/monitor, report builder, mobile welfare sensors, legacy-form retirement.

### Modularity conclusion (the standalone+integrated question)
The SYSTEM is in place and sound: `moduleManifest.requiresSpines` + `organization_modules` gating means a module CAN run standalone (spines always present) and integrated (shared spine). The one caveat is that the **geofence spine sits on a deprecated table** — so "standalone" modules that geofence inherit that weakness until Phase 1. Fix Phase 1 and the modular story is genuinely solid.

_AUDIT COMPLETE (all rings). This doc is the reference for the fix roadmap; do Phase 1 first._

---

## BILLING MODEL (Phase 4 spec — OWNER-CONFIRMED 2026-07-06)

> Supersedes the "billing-model pending" note on GenerateInvoicePage. Confirmed design
> to build finance/invoice-generation against. Capture reasoning, not one-offs (house rules).

### Principle: HYBRID + EVIDENCE-GATED
Bill by **line-type**, and bill what was **PROVEN delivered**, not what was rostered
(legal-defensibility for council contracts; the moat vs generic invoicing).

| Line type | Rate source (bureau) | Billed from (ACTUAL, not scheduled) | Gate |
|---|---|---|---|
| **Fixed monthly** | flat monthly rate | schedule (recurring) | none |
| **Alarm response** | callout/per-event rate | dispatch jobs that OCCURRED | SLA scale (see below) |
| **Patrol** | per-visit rate | COMPLETED stops (proven attendance) | missed check = NOT billed |
| **Static guard** | hourly (agreement) and/or on-site hours | timesheets / shift actuals | verified hours |

### SLA BILLING — per-service SCALED discount (ONE uniform mechanism)
Each **module/service defines its own SLA config**: a `response_sla_minutes` target + an
ORDERED list of over-SLA **bands** `{ over_by_minutes -> discount_% }`. Late-but-attended =
reduced charge; a **100% band = the non-billable cutoff** (no separate field needed).
Toggle/stage: define many bands (staged), one band (flat), or a single 100% band (hard cutoff).
- **Alarm (SLA 45):** e.g. `+10min->25%`, `+30min->50%`, `+60min->100%`. (25% off if ~10 late; free if very late.)
- **Noise (SLA 60):** `+1min->100%` — anything past 60 is non-billable. (single 100% band.)
- **Patrol:** attendance-gated (missed = $0); expressible as "no completion -> 100%" to stay uniform.
Computation uses EXISTING evidence + timestamps: `sla_clocks`, dispatch `*_at`, `record_sla_arrival` (actual attendance time vs alarm/despatch DTS).

### BILLING BUREAUS (WILSAR-style charge-rate schemes) — the rate engine
A **billing bureau** = a named, reusable charge-rate scheme you ASSIGN sites/clients to (FS
source data already carries `Bureau ID`/`Bureau Name`). Modelled on Wilson "Charge Rate Maintenance":
- **Bureau:** code, name, status (active/locked), charge_rate_type (client/subcontractor), comments, audit dates, linked clients/sites.
- **MULTI-SERVICE:** ONE bureau holds rates across ALL modules/services (patrol/alarm/static/monthly) — a full rate card, not one type per bureau.
- **Zone tiers:** Metro / Country / Far Country / Remote — resolved by **POINT-IN-GEOFENCE** (site location -> zone polygon; reuses resolve_context). Auto, not manual => depends on the geofence spine (Phase 1).
- **Per-rate fields (WILSAR set + SLA scale):** default charge, additional charge + additional charge period, charge period, day surcharge, response_sla_minutes + over-SLA discount BANDS, charge-per-km / billing landmark, override-charge-date-by (Alarm Response DTS vs Despatch Entry DTS).

### Resolution (cascading)
> **Rate = site's ASSIGNED bureau -> that bureau's rate for the service/line-type -> priced at the site's GEOFENCE ZONE tier -> apply SLA-band discount from actual attendance time.**
> No bureau assigned -> fall back to the **STANDARD/default bureau** (baseline rate card).
> Example: **NCC** has its own bureau (fixed rate); assign all NCC sites -> they inherit it. Everyone else = Standard.

### Confirmed
- Zones = point-in-geofence (auto). ✅
- One bureau = MULTIPLE service/line-types (full rate card) + Standard default + client overrides. ✅
- SLA = per-service SCALED bands; 100% band = non-billable cutoff; toggle/stage. ✅

### Open (resolve before building Phase 4)
1. **Static guard "and/or":** agreement contracted hours vs ACTUAL on-site time — which wins when they differ (higher-of / actual / per-bureau config)?
2. **Patrol evidence threshold:** "the check happened" = attended (GPS/checkpoint scan) or stop marked complete?
3. **Cadence:** monthly invoice per client/site aggregating all line-types over `invoices.service_period_*`? (assumed yes.)

### Schema implication (Phase 4, new migration)
Likely new: `billing_bureaus` + `bureau_charge_rates` (bureau_id, service/line_type, zone_tier, WILSAR fields) + `bureau_sla_bands` (rate_id, over_by_minutes, discount_pct) + assignment (`client_sites.billing_bureau_id` / org-level). Reference-table pattern (house rule). Existing `crm_commercial_settings`/`site_financial_config` (0079/0080) may fold in or be superseded — decide at build time. Bob PROPOSES the migration; never runs DDL.

### Dependency
**Phase 1 (fix the geofence spine / deprecated `locations`) must land first** — billing zones ride on the same geofence layer.

---

## NOISE CONTROL MODULE — Remediation Plan (2026-07-11)

> **Status:** Architecture decided. Migration 0153 on branch `feat/noise-control-tdc-matrix`.
> Page rebuild in progress. Issues: [#58](https://gitlab.com/don-squires1/field-compliance-manager/-/work_items/58) [#59](https://gitlab.com/don-squires1/field-compliance-manager/-/work_items/59) [#60](https://gitlab.com/don-squires1/field-compliance-manager/-/work_items/60)

### What the module is
Noise control enforcement for NZ councils (Iron Eagle operates under contract to TDC — Timaru District Council). Officers respond to noise complaints, assess using the TDC matrix, and issue Excessive Noise Directions (ENDs) or seize equipment under RMA 1991 s.326/327.

### What was wrong with the old page
- 6-step decibel form — not aligned to TDC operational procedure
- Prior notice count was a manual dropdown, not queried from DB
- `noise_seizures` table existed but had no write policies and no UI
- `notice_number` column existed but was never populated
- No credential gate (warrant check before notice issuance)
- No address-to-site linkage or jurisdiction check
- No GPS evidence, no three-address model
- No H&S pre-visit checklist
- No incident report generation
- `NoticeGenerationPanel` generated HTML but wrote nothing to DB

### Architecture decision: TDC Matrix as primary assessment engine

The TDC matrix is the operational standard. AI (Bob) is a supporting layer, not the decision engine.

**Matrix scoring:**

| Dimension | Options | Score |
|---|---|---|
| Volume | No Noise / Barely Audible / Clearly Audible / Loud / Extremely Loud | 0–4 |
| Time of day | 7am–9pm / 9pm–midnight / midnight–2am / 2am–7am | 1–4 |
| Tone/Bass | No bass / Slight bass / Heavy bass | 0–2 |

Rule: Volume = 0 → time score ignored → total = 0 regardless.

**Action path:**
- Score 0 → No Noise — no action
- Score 1–4 → Acceptable — no action
- Score 5+ AND first visit, cooperative, not problem address → Verbal Warning
- Score 5+ AND (second visit OR uncooperative OR problem address) → END (Excessive Noise Direction)
- END within 72hrs OR permanent Abatement Notice → Seize equipment (police must be present)

**Hard rules (never negotiable):**
- Barking dog complaints → refer to TAS/Animal Control, do not attend
- Complainant identity never disclosed to offending address
- No entry or seizure without police present
- Action is COMPUTED by the rules, not chosen by the officer

### New workflow phases

**Phase A — Job creation**
Complaint address, time received, officer, dispatcher. Barking dog check blocks job creation.

**Phase B — H&S pre-visit checklist (mandatory gate)**
Phone charged / risk assessment / exit routes / vehicle parked / BWC activated.
Abort conditions: immediate danger → 111; personal risk → Welfare/Comms; H&S concern → NSC.

**Phase C — GPS + three-address evidence**
Three distinct locations captured separately:
1. Complaint address (from dispatch, read-only)
2. Assessment location (where officer stood — GPS + description)
3. Actual noise source address (the property producing the noise)
Warn if source ≠ complaint address. Warn if assessment GPS >150m from complaint address.

**Phase D — TDC Matrix scoring**
Volume + Time (ignored if Vol=0) + Tone = total. Colour-coded result. Computed, displayed.

**Phase E — Contextual factors (score ≥ 5 only)**
Visit number tonight / problem address / uncooperative / END within 72hrs / permanent abatement / police present.

**Phase F — Action execution (computed, officer confirms)**
- Verbal Warning: notes + time
- END: END number (mandatory) + occupant name (mandatory) + 2 mandatory photos (assessment point + source address letterbox)
- Seizure: police present (hard gate) + police name + item description + seizure form number + equipment photo (mandatory)

**Phase G — Incident report (auto-generated)**
Job number / time on site / matrix score / action / officer name / END number + occupant (if END) / seizure form (if seized) / GPS coordinates.

### Evidence model (court-ready)
Every job produces an evidence package:
1. Original complaint
2. Dispatch record
3. GPS arrival coordinates + timestamp
4. Three-address record
5. H&S checklist
6. Photographs (assessment point, source address, service evidence, equipment if seized)
7. Matrix score breakdown
8. Issued notices with legislative authority
9. Seizure record
10. Incident report + officer declaration

PDF generation deferred to #60.

### Database changes (migration 0153 — on branch, not yet merged)

`noise_assessments` additions:
- Matrix: `volume_score`, `time_score`, `tone_score`, `matrix_total`
- Job: `job_number`, `received_at`, `arrived_at`, `departed_at`, `visit_number_tonight`
- Flags: `is_problem_address`, `prior_end_within_72hrs`, `permanent_abatement_active`, `occupant_cooperative`, `police_requested`, `police_present`, `referred_animal_control`, `complainant_protected`
- END: `end_number`, `occupant_name`
- H&S: `hs_checklist_completed`, `hs_checklist_items`, `hs_abort_reason`
- Three-address + GPS: `assessment_location`, `assessment_gps_lat/lng/accuracy`, `noise_source_address`, `noise_source_gps_lat/lng`, `arrival_gps_lat/lng/accuracy`, `address_discrepancy_noted`, `address_discrepancy_reason`
- Photos: `photo_assessment_point`, `photo_source_address`, `photo_service_evidence` (JSONB)
- Output: `incident_report_text`, `evidence_package_url`

`noise_seizures` additions:
- **Write policies added** (was SELECT-only per LIVE_SCHEMA)
- `police_present`, `police_name`, `photo_urls`, `seizure_form_number`, `legal_authority`, `organization_id`

Job number sequence: `noise_job_seq` + `generate_noise_job_number()` function.

### Files to modify

| File | Status |
|---|---|
| `supabase/migrations/0153_noise_control_tdc_matrix.sql` | ✅ Done — on branch |
| `apps/web/src/pages/modules/NoiseControlPage.tsx` | ❌ Full rewrite needed |
| `docs/db/LIVE_SCHEMA.md` | Update after migration applied |

### Deferred (tracked in issues)
- #60: PDF evidence package edge function
- #60: Monthly statistics dashboard for council reporting
- #59: GIS map view of assessment locations
- Audio recording support
- Credential gate (noise_control_warrant check before END issuance)
- Legislative intelligence layer (council-selectable legal framework)

---


> ⚠️ `locations` is STILL LOAD-BEARING — this is a STAGED, data-migrating, reversible
> repoint, NOT a quick drop. Do NOT write the migration blind. VERIFY LIVE first.

### Repoint surface (mapped from code)
- **`LocationsPage.tsx`** — WRITES `locations` (createLocation insert) + reads `location_zones` **via `location_id`** (NOT `site_id`). So zones created/shown here are keyed to `locations.id`.
- **`location_zones`** — has BOTH `location_id` (old link) AND `site_id` (canonical -> client_sites). Straddles both worlds; LocationsPage uses the OLD link.
- **`PatrolCheckpointsPage.tsx`** — checkpoints keyed to `location_id -> locations`.
- **Patrol pipeline (P5, STAGING)** — relies on the chain `patrol_checkpoints.location_id -> locations.client_site_id -> shift_stops.site_id`. So `locations` is an ACTIVE BRIDGE in patrol, not just dead UI. Dropping it blind would break checkpoint->stop mapping.
- Other anchors (from #9): `incidents.location_id`, `person_interactions.location_id`, `vehicle_flags.location_id` (0103) — confirm live.

### VERIFY-LIVE gate (run before ANY code)
```sql
select to_regclass('public.locations') as exists;
select count(*) from public.locations;                 -- if it exists
select conrelid::regclass as referencing_table, conname -- what still FK-refs it
  from pg_constraint where confrelid='public.locations'::regclass and contype='f';
select count(*) from client_sites; select count(*) from location_zones;
select count(*) from location_zones where location_id is not null;  -- old-linked zones
select count(*) from location_zones where site_id is not null;      -- canonical-linked
```
The answers decide the path: EMPTY+UNREFERENCED -> simple drop + UI repoint. STILL
REFERENCED / zones on location_id -> the staged sequence below.

### Staged sequence (reversible; each step verified before the next)
1. **Repoint the UI reads** — LocationsPage: show Sites from `client_sites` + Zones from `location_zones` via **`site_id`**; new-zone form links `site_id`. PatrolCheckpoints: key to `client_sites` (or keep the bridge until step 3). NO drops yet.
2. **Migrate the data** — additive migration: for each `location_zones` row with `location_id` but no `site_id`, set `site_id = locations.client_site_id` (the bridge). Same for `patrol_checkpoints`. Backfill, don't destroy.
3. **Repoint the pipeline** — process-officer-scan / patrol P5 to use `site_id` directly (drop the `locations` bridge hop). Repoint incidents/person_interactions/vehicle_flags anchors to client_sites (or the entity model per #9).
4. **Verify** everything reads canonical + nothing references `locations`.
5. **Drop `locations`** — last, in its own migration, only once step-4 confirms zero references.

### Why staged (the lesson)
#7/#8/#9 stalled because this was treated as one big move. Each step above is independently
shippable + verifiable + reversible. Bob PROPOSES each migration; a human approves; never DDL by Bob.

_Remedial work is BLOCKED on the verify-live SQL. Run it, then execute step 1._
