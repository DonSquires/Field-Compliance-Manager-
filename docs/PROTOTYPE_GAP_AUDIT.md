# Prototype Gap Audit

Date: 2026-09-03

This audit compares the current Field Compliance Manager checkout against the accessible historical prototype repositories listed in [historical-sources.md](historical-sources.md). Treat this as a capability recovery and product-gap map, not an instruction to copy prototype code. The earlier Freedom Camping app was close to the desired field workflow, but it failed as a coherent platform because modules were bolted on rather than designed into a shared enterprise SaaS spine. The current checkout is intended to be a copy/mirror of Bob's GitLab source with additional rebuild work layered here; both are the new purpose-designed development line. Gaps in this line are expected and should be filled with coherent SaaS-grade design against the current schema, Atlas, module architecture, and the master platform baseline in [MODULE_BASELINE_REQUIREMENTS.md](MODULE_BASELINE_REQUIREMENTS.md).

Required platform systems from the GitLab line: Atlas, Caddie, Conductor, and Oracle. These are not prototype-only ideas. They should be present, wired, and used in this build repo wherever their responsibilities apply.

See [GITLAB_PLATFORM_SYSTEMS.md](GITLAB_PLATFORM_SYSTEMS.md) for the GitLab-derived system specs. Oracle is broader than welfare: it is the truth-state describer for the current turn, caller, candidate effect, proof grade, and any domain state the Conductor needs before enforcement.

## Sources Checked

| Source | Access result | Useful evidence |
| --- | --- | --- |
| `FreedomCamp-Manager-App` | Cloned | Substantial Expo/React Native field prototype with offline database, sync, upload queue, scan, jobs, welfare, tracking, notifications, and photo services. Strong workflow reference, but not a coherent architecture to port wholesale. |
| `fieldops-railway-stt` | Cloned | FastAPI/Faster-Whisper `/transcribe` and `/health` service shape. |
| `orc-ai-inference-service` | Cloned | Minimal Vite placeholder only; no meaningful inference service implementation found. |
| `Bob` | Cloned | README-only historical placeholder. Current Bob implementation in this repo is much deeper. |
| `https-react-9b4t5o.onspace.build` | Cloned | README-only historical UI export placeholder. |
| `FreedomCamp-Manager` | Not accessible | GitHub returned 403 from this container. Needs read-only credential or Bob/GitLab-assisted recovery. |
| `preview-react-9b4t5o-efbho4rc5qcj7zhif8e3zw.onspace.build` | Inspected as a live early preview | Freedom Camping admin prototype covering dashboards, zones, patrol activity, breaches, H&S, enforcement, and reporting. It directly queries/writes older tables such as `zones`, `vehicle_records`, `health_safety_reports`, and `enforcement_actions`; use as workflow/UI evidence only, never as a current schema or architecture source. |
| GitLab `don-squires1/field-compliance-manager` project `83317421`, ref `Main` | Queried through deployed `bob-repo-search` using a grand_master test session | Most recent external build lineage. Searches and targeted reads were used for scan shell, officer shell chrome, live patrol monitor, parking evidence dry-run, mobile TODOs, push tokens, and job/enforcement terms. |

## Bob/GitLab Evidence

Live `bob-repo-search` was first probed from this container with the available Supabase service-role bearer and returned `Unauthorized`. That is expected: the function requires a real authenticated `grand_master` user JWT, then reads GitLab server-side with its configured `GITLAB_READ_TOKEN`. After using the Codespace grandmaster test credentials to obtain a user session, live Bob/GitLab searches and targeted reads succeeded.

The checkout does contain prior Bob-derived GitLab extraction artifacts:

| Artifact | Evidence quality | GitLab details recovered |
| --- | --- | --- |
| `bob_code_extraction.json` | 5,000 Bob messages searched; 59 unique files mentioned; 1 complete file extracted. | Complete `apps/web/src/routing/RoleRouter.tsx`; referenced `BobPanel`, `NotificationsBell`, `PreArrivalDossier`, `ReportButton`, `DispatchConsolePage`, `LivePatrolMonitorPage`, `PatrolPage`, `WelfareAlertsPage`, `ParkingEnforcementPage`, `NoiseControlPage`, and `ScanShell`. |
| `CORE_PAGES_EXTRACTION.json` | 68 Bob messages analyzed; sequential line-window reads; 4,802 total lines transcribed. | Complete `AdminShell.tsx` (810 lines), complete `OfficerShell.tsx` (975 lines), complete `AdminHubPage.tsx` (599 lines), complete `RoleRouter.tsx` via the other artifact, partial `DispatchConsolePage.tsx` (major sections), and partial `WelfareAlertsPage.tsx`. |
| `docs/ui-baseline.md` | Human-curated rebuild baseline from Bob's GitLab reads. | Verified safety, shell, module-gating, dispatch, welfare, and UI rebuild requirements, including known defects to avoid. |

Additional live Bob searches on 2026-09-03 found:

| Query area | Bob/GitLab result | Rebuild implication |
| --- | --- | --- |
| `apps/mobile`, `expo-sqlite`, `sync-organization-data`, `uploadQueue` | `apps/mobile` found only in docs/TODO and architecture references; `expo-sqlite` and `sync-organization-data` returned `not_found`; `uploadQueue` appeared in parking dry-run docs. | The recent GitLab build does not appear to contain the offline Expo implementation from `FreedomCamp-Manager-App`; mobile offline remains a real missing build, not just a missing port from GitLab. |
| `push_token`, `notification_preferences`, `expo-notifications` | All returned `not_found`. | Mobile push notification spine remains missing in the GitLab evidence too. |
| `investigation_jobs`, `dispatch_jobs`, `shift_stops`, `enforcement_actions` | `dispatch_jobs` and `shift_stops` were heavily present; `investigation_jobs` returned `not_found`; `enforcement_actions` had only one hit. | Current/recent lineage uses dispatch and shift-stop spines rather than the prototype `investigation_jobs` table. Do not recreate old job tables without schema review. |
| `evidence_media`, `photo_urls`, `court-ready`, `retention`, `hash` | `evidence_media` returned `not_found`; `photo_urls`, `court-ready`, `retention`, and `hash` had many hits, especially parking stress/dry-run and migration docs. | Evidence requirements exist, but no shared `evidence_media` spine was found by name. A unified media model remains a likely gap. |
| `ScanShell`, `FieldSafetyBar`, `PttBar`, `PreArrivalDossier`, `NotificationsBell` | All found. Targeted reads confirmed `ScanShell.tsx` and inline `OfficerShell` chrome details. | GitLab had richer shell/chrome intent than current mobile, but some pieces were stubs or intentionally absent from scan mode. |

Bob's GitLab evidence describes a recent web build with these notable surfaces:

- `RoleRouter.tsx` enforced role-based portal routing for admin/master/grand_master/admin_officer/nzscv_monitor, officer, scan_operator, and client roles.
- `OfficerShell.tsx` had four officer states: standby, roster-first officer home, module selector, and module portal. A live read of lines 280-405 confirmed route cases for leave, timesheet, schedule, overnight verification, checkpoint scan, modules, map, dispatch, debrief, vehicle lookup, and credentials.
- Officer shell rendered `FieldSafetyBar`, `PortalSwitcher`, and `NotificationsBell` above the main content. `NotificationsBell` mapped officer notifications to `overnight_verification`, `checkpoint_scan`, `schedule`, `report`, and `dispatch` modules.
- `PttBar` was inline inside `OfficerShell`, not a separate component file. A live read of lines 820-855 showed a static channel label (`Ch: Alpha 1`) and `HOLD TO TALK` button. Treat it as UI intent/stub evidence, not proof of working PTT runtime wiring.
- `ScanShell.tsx` was real and intentionally minimal: a dedicated `/scan` entry for `scan_operator` users and standalone-mode officers. Its header explicitly says no roster tab, no dispatch board, no welfare check-in prompts, and no PTT bar. It renders module pages directly and imports `ReportButton`.
- Officer GPS heartbeat cadence in the GitLab evidence was `GPS_HEARTBEAT_MS = 120000` (2 minutes), persisted to `officer_gps_log`.
- GitLab `OfficerShell` used a single shell-level GPS watcher shared with safety UI rather than separate per-module watchers.
- GitLab module access used role grants plus organization module configuration, but had a fail-open ambiguity on module config read errors. The current rebuild has since hardened this pattern.
- `LivePatrolMonitorPage.tsx` was a real admin card monitor. A live read of lines 1-240 confirmed it reads latest `officer_gps_log`, active `shifts`, `shift_stops`, and `patrol_checkpoint_visits`; auto-refreshes every 30 seconds; and flags missed/at-risk expected stops against SLA arrive-by times.
- `DispatchConsolePage.tsx` was a large real-time dispatch console with shift/stop/job columns, mobile tabs, active shifts, recent jobs, client sites, dispatch resources, officer GPS, and `PreArrivalDossier` integration.
- `AdminHubPage.tsx` exposed KPI counts for observations/scans, active breaches, active patrols, and welfare alerts plus module cards and trend charts.
- `WelfareAlertsPage.tsx` covered check-in, missed check-in, SOS, and man-down alert triage with acknowledgement/resolution state and realtime subscription, but Bob extraction for that page was partial.

Implication: the GitLab source mostly strengthens the web/admin/officer safety and dispatch baseline for the new purpose-designed line. It does not reduce the biggest measured gap in this checkout: the current `apps/mobile` still lacks the operational offline field app depth that the old Freedom Camping prototype explored. That mobile capability should be rebuilt coherently on the current SaaS spine, not revived as a separate bolted-on module stack.

## Current Build Baseline

The current checkout is broader than the main Expo prototype on web and backend:

- `apps/web` has officer, admin, client, scan, CRM, rostering, dispatch, field reports, vehicle lookup, welfare, parking, freedom camping, noise, biosecurity, smoke, billing, locations, geofence, Bob, Atlas, and reporting pages.
- `supabase/functions` includes the current centralized scan and AI path: `process-officer-scan`, `classify-photo`, `classify-parking-scene`, `bob-inference`, `bob-voice-transcribe`, `bob-voice-speak`, `bob-resolve-address`, `bob-resolve-geofence`, `linz-lookup`, `motoweb-vehicle-lookup`, and many Bob builder/control-plane functions.
- `supabase/schema.sql` contains current spines for `officer_gps_log`, `welfare_checks`, `officer_welfare_settings`, `parking_chalk_records`, `vehicle_overnight_sessions`, `ptt_channels`, `ptt_transmissions`, `radio_transcript_segments`, and `radio_translation_segments`.
- `apps/mobile` now has secure Supabase session persistence and an initial vehicle scan slice: camera/gallery evidence, foreground GPS, governed `process-officer-scan` submission, and durable retry queue for network failures. It does not yet contain the broader operational mobile modules that existed in `FreedomCamp-Manager-App`.

## Required GitLab Platform Systems

These systems are part of the intended GitLab-copy build line and should be treated as load-bearing in this repository:

| System | Role in this build repo | Current local anchor |
| --- | --- | --- |
| Atlas | Capability map, terrain graph, gap report, and blast-radius impact analysis. Used before changing shared tables, hooks, components, functions, or module spines. | `bob_capability_map`, `bob_app_map_edges`, `bob-query-atlas`, `scripts/atlas-*`, [docs/ATLAS_BUILD_REPORT.md](ATLAS_BUILD_REPORT.md), [docs/ATLAS_REBUILD_ORDER.md](ATLAS_REBUILD_ORDER.md), [docs/ATLAS_WIRING_STATUS.md](ATLAS_WIRING_STATUS.md) |
| Caddie | Generates Bob's tool catalogue from Atlas-wired/reachable capabilities; describes available tools but does not select them. | `supabase/functions/onspace-ai-chat/caddie.ts` |
| Conductor | Bob's turn gate/dispatcher: manages routing, tool dispatch, governance, egress enforcement, task/memory/fact state, and safety seams. | `supabase/functions/onspace-ai-chat/index.ts` |
| Oracle | Truth-state evaluation layer used by policy/safety decisions; describes state so the Conductor can enforce at the right boundary. | `supabase/functions/onspace-ai-chat/conductor-welfare-seam.ts`, `oracle-welfare-safety` Atlas feature |

Implementation rule: if a capability is missing in this checkout but present or specified in GitLab, fill it through these systems rather than bypassing them. For example, a new mobile scan feature should still be checked through Atlas blast-radius, routed through current scan/geofence/evidence contracts, and avoid creating a parallel bolt-on spine.

## High-Value Missing or Thin Areas

## Early Preview Lessons

The supplied Onspace preview is an early Freedom Camping admin design, not part
of the GitLab-copy SaaS line. Its visible product intent is useful: daily
operations dashboard, officer activity, zone activity, breaches, patrols,
geofencing, H&S, enforcement, and compliance reporting. It demonstrates the
field operations domain the current build must cover coherently.

Its implementation is specifically not a recovery target. Bundle inspection
showed direct browser writes to legacy tables and a single-app model, including
`zones`, `vehicle_records`, `health_safety_reports`, and
`enforcement_actions`. The current build must use its governed current spines:
location/site/zone authority, `process-officer-scan`, dispatch and shift stops,
current welfare/evidence workflows, Atlas, Caddie, Conductor, and Oracle.

Reuse the early preview for task hierarchy and scanability. Do not reuse its
table names, client-side write patterns, role model, or module boundaries.

### 1. Mobile Offline Field App

Prototype evidence: `FreedomCamp-Manager-App/services/database.ts`, `syncService.ts`, `uploadQueue.ts`, `complianceService.ts`, `cameraService.ts`, `trackingService.ts`, and `welfareService.ts`.

Current status: initial mobile scan capture/submission and retry queue are present; broader offline field operations remain missing from `apps/mobile`.

Design stance: this is an expected gap in the new build, not a regression to patch by copying the old app. Rebuild it as a first-class mobile client of the current Field Compliance Manager platform.

What is missing or thin:

- Queue inspection, retry state, and discard controls are now available inline on the mobile scan screen. A dedicated queue screen remains optional until additional queued action types exist.
- Local SQLite cache of zones, compliance rules, canonical vehicles, flagged vehicles, monthly stays, and recent observations.
- Organization data package download equivalent to prototype `sync-organization-data`.
- Multi-type offline upload queue for observations, updates, deletes, incidents, photos, and notes.
- Local compliance calculation for offline breach/at-risk decisions.
- Local photo storage with compression and retry-safe upload.

Current overlap:

- Web has IndexedDB queueing for officer scans in `apps/web/src/lib/officerScan.ts`.
- Server `process-officer-scan` has stronger authoritative ALPR, inference, geofence, parking, freedom camping, and storage handling than the prototype service path.
- Mobile has secure auth shell only; it should consume the current server contracts rather than revive old table names like `vehicle_observations_v2`.

Recommended recovery:

1. Build `apps/mobile` around the current `process-officer-scan` contract first.
2. Add a local SQLite cache only after defining a current data package function against current tables: `location_zones`, `zone_compliance_matrix`, `canonical_vehicles`, `entity_flags`, `vehicle_overnight_sessions`, `observations`, shifts/stops, and module entitlements.
3. Keep server as source of truth for final compliance; allow local offline verdicts to be labelled provisional until synced.

### 2. Mobile Background GPS, Welfare, and Man-Down

Prototype evidence: `trackingService.ts` sends repeated GPS pings; `welfareService.ts` handles inactivity warnings, auto-logoff, and investigation exemption.

Current status: backend and web support exist; mobile implementation is missing.

What is missing or thin:

- Background location permissions and periodic GPS heartbeat while the app is not active are now available as an officer-controlled active-shift task. It uses the same two-minute `record_officer_breadcrumb` path and retains unconfirmed events for retry.
- Mobile calls to current `record_officer_breadcrumb` RPC or equivalent write path are now present for foreground heartbeats.
- Mobile welfare check-in prompts and overdue state handling. Foreground self check-in and confirmed SOS are now available from the mobile scan safety bar; timer/overdue presentation remains follow-up work.
- Mobile man-down/inactivity timers integrated with the current `officer_welfare_settings` schema.
- Offline retention of GPS breadcrumbs with client event IDs for retry provenance.

Current overlap:

- Current schema has `officer_gps_log`, `welfare_checks`, and `officer_welfare_settings`.
- Current web has officer safety hooks and live map/admin welfare visibility.

Recommended recovery:

1. Port the concept, not the table names: use `record_officer_breadcrumb`, `welfare_checks`, and `officer_welfare_settings`.
2. Add mobile background-location capability only after permission UX and battery policy are designed.
3. Preserve device capture time separately from server receipt time, matching the current schema comments.

### 3. Mobile Push Notifications and Notification Center

Prototype evidence: `notificationService.ts` registers Expo push tokens, stores notification preferences, listens for foreground/background notification events, and manages badges.

Current status: not found in current mobile; current schema search did not show `push_token` or `notification_preferences` in `supabase/schema.sql`.

Current implementation: the mobile scan screen now includes an in-app inbox that reads the existing canonical `notifications` stream, receives realtime refreshes, and marks items read through the RLS-permitted update path. This is not device push delivery.

What is missing:

- Expo notification dependency and device registration in `apps/mobile`.
- Current-schema table or column for device tokens and preferences.
- Dispatch/breach/welfare notification routing to mobile devices.
- Notification tap deep links into officer schedule, dispatch, breach, scan, welfare, or report screens.

Current overlap:

- Web has notification surfaces and Bob bell/conductor notification functions, but that is not a mobile push system.
- `officer_welfare_alerts` appears in docs and web surfaces, but push token persistence was not found in schema during this pass.

Recommended recovery:

1. Add a current-schema `officer_device_tokens` or equivalent table rather than adding token columns to `user_profiles` without blast-radius review.
2. Start with assignment, welfare/SOS, and breach notifications.
3. Add mobile notification preferences after core delivery is verified.

### 4. Mobile Jobs, Patrols, and Enforcement Workflows

Prototype evidence: routes under `FreedomCamp-Manager-App/app/jobs`, `app/patrols`, `app/enforcement/create.tsx`, `app/observation-edit.tsx`, `app/vehicle-details.tsx`, and `app/zone-create.tsx`; prototype docs reference `investigation_jobs`, `enforcement_actions`, and `patrols`.

Current status: web/admin/officer surfaces exist, but mobile operational screens are missing. Current schema search did not find prototype table names `investigation_jobs`, `enforcement_actions`, or `officer_activity_log`; current equivalents appear to be `dispatch_jobs`, `shifts`, `shift_stops`, `shift_stop_actions`, `officer_field_reports`, `breach_alerts`, and module-specific assessment tables.

What is missing or thin:

- Active-shift mobile dispatch list and status progression are now available. Broader cross-shift job history/detail workflows remain missing.
- Mobile patrol route/stops view.
- Governed mobile field reporting is now available for incident, maintenance, and health-and-safety reports with active-shift attribution, idempotency, optional GPS evidence, immediate action, and follow-up requirements.
- Mobile enforcement action/notice capture from a scan or breach.
- Mobile vehicle detail page with canonical vehicle, breach history, SCV/homeless status, and flags.
- Mobile read-only credential status is now available with verification state and expiry warnings. Credential renewal remains a governed HR workflow.
- Mobile leave request and personal leave status are now available through the idempotent `submit_officer_leave_request` RPC. Leave approval remains a governed supervisor workflow.
- Mobile timesheet submission and personal status are now available through the idempotent `submit_officer_timesheet` RPC. Timesheet review and approval remain governed HR workflows.
- Mobile end-of-shift debrief is now available through `submit_shift_debrief`, followed by separately confirmed `complete_officer_shift` lifecycle completion once server checks pass.
- Mobile zone/site creation or provisional boundary capture, if this remains an officer workflow.

Current overlap:

- Web officer pages cover dispatch, debrief, field report, parking, freedom camping, biosecurity, noise, vehicle lookup, credentials, leave, timesheets, and schedule.
- Admin web covers dispatch console, roster, patrol oversight, breach review, field reports, and operational places.

Current implementation: mobile now provides a read-only vehicle lookup for canonical vehicle compliance, SCV status, recent observations, breach history, and organization-scoped active flags. It does not mutate vehicle, flag, or enforcement records.

Current implementation: mobile now shows the active shift's materialized patrol stops and completes a stop through `complete_shift_stop`, carrying officer notes and a foreground GPS fix when available. QR/NFC checkpoint capture remains a separate native evidence capability.

Current implementation: mobile QR checkpoint capture is now available for active shifts. It resolves an active organization checkpoint, verifies GPS accuracy and checkpoint radius when the checkpoint has coordinates, creates or reuses the shift patrol session, and records `patrol_checkpoint_visits.scan_method='qr_camera'`. NFC and non-QR checkpoint modes remain follow-up work.

Recommended recovery:

1. Map prototype `jobs` to current `dispatch_jobs` plus `shift_stops`; do not recreate `investigation_jobs` unless schema review confirms a real missing domain.
2. Add mobile read-only job and stop list first, then completion/debrief writes through current RPCs/functions.
3. Treat enforcement action generation as a backend/RPC workflow so mobile does not hand-roll notice authority.

### 5. Evidence Photo Integrity and Retention

Prototype evidence: `services/README_PHOTO_UPLOAD.md` specifies photo size validation, compression, SHA256 hashing, metadata, retention policies, court-ready evidence, soft delete, and batch upload.

Current status: server scan path stores original/watermarked scan images, and `parking_chalk_records.photo_urls` is schema-commented as metadata JSON. A dedicated current photo metadata/retention table was not found in this pass.

What is missing or thin:

- A unified evidence media model across scans, field reports, incidents, noise, biosecurity, smoke, and enforcement.
- Hash/integrity fields exposed as first-class schema rather than buried per-module.
- Retention policy state and court-ready lock semantics.
- Mobile local photo vault and queued upload metadata.
- Evidence export chain tying photos, officer, GPS, address, zone, and device capture time together.

Current overlap:

- `process-officer-scan` uploads original and watermarked scan files.
- Field report and module pages capture evidence context, but not a shared media spine.

Recommended recovery:

1. Design a shared `evidence_media` spine or confirm an existing equivalent in schema/Atlas.
2. Move court-ready retention and hashing into that spine.
3. Have module records reference evidence media rather than each inventing `photo_urls` shapes.

### 6. Push-to-Talk and Voice/STT Runtime Completion

Prototype evidence: `fieldops-railway-stt` provides a concrete `/transcribe` and `/health` shape using Faster-Whisper CPU. Current repo has `ptt-server`, `bob-voice-transcribe`, `bob-voice-speak`, PTT schema tables, and radio transcript/translation tables.

Current status: backend pieces exist; app UI integration appears intentionally incomplete.

What is missing or thin:

- Officer/mobile PTT runtime is not built out. GitLab `OfficerShell` contained an inline static `PttBar`, while current rebuild guards intentionally prevent treating it as live officer-shell functionality until the runtime is designed.
- `ptt-server` has a plain text root response, while `check-services-health` calls `/health`; no `/health` route was found in `ptt-server/dist/index.js`.
- Current `fieldops-railway-stt` prototype is not wired as a deployed dependency in this checkout; current voice functions expect an apps/api/fcm-voice path.
- Radio transcript and translation tables exist, but end-to-end UI/runtime wiring needs verification.

Recommended recovery:

1. Add `ptt-server` `/health` if `check-services-health` is intended to monitor it.
2. Decide whether `fieldops-railway-stt` remains a separate deploy or is replaced by the current fcm-voice path.
3. Build PTT as a controlled officer/mobile module with transcript persistence to `ptt_transmissions` and `radio_transcript_segments`.

### 7. Prototype Features Not Worth Porting Directly

These sources did not add meaningful recoverable implementation in this pass:

- `orc-ai-inference-service`: only a minimal Vite page was found.
- `Bob`: README-only; current Bob control plane and edge functions in this repo are the authoritative implementation surface.
- `https-react-9b4t5o.onspace.build`: README-only.

## Priority Gap Backlog

| Priority | Gap | Why it matters | Suggested first validation |
| --- | --- | --- | --- |
| P0 | Mobile offline scan shell using current `process-officer-scan` | Field officers need reliable capture away from network. | Mobile unit/TS check plus one mocked scan submission test. |
| P0 | Mobile GPS/welfare heartbeat against current schema | Lone-worker safety depends on continuous, retry-safe signal. | Mobile service test for queued breadcrumb payload shape. |
| P1 | Current-schema offline data package | Enables provisional local compliance without old table drift. | Edge function test proves package only reads current tables and RLS-safe scope. |
| P1 | Mobile job/dispatch list and completion | Prototype had jobs; current mobile has only assignment summary. | Mobile screen test with mocked `dispatch_jobs`/shift stop data. |
| P1 | Push notification token + delivery spine | Assignments, welfare, and breaches need app-closed delivery. | Schema guard and mocked Expo token registration flow. |
| P2 | Unified evidence media spine | Court-ready evidence should not be module-specific JSON. | Schema migration guard plus process-officer-scan media write check. |
| P2 | PTT health/UI/runtime completion | Current schema/server pieces exist but app integration is unfinished. | `ptt-server` health test plus officer/mobile PTT guard. |

## Governed Module Gaps

Biosecurity is not yet added to mobile. The current officer web flow writes
`biosecurity_assessments` directly, then separately invokes
`capture-environmental-evidence`. Atlas confirms both edges. That split would
recreate the older bolt-on pattern in the mobile app: an assessment can succeed
while evidence processing is unconfirmed. Before adding mobile biosecurity,
create one idempotent governed submission command that owns the assessment
record, evidence attachment, audit record, and partial-failure receipt together.
The selected design, domain invariants, delivery sequence, and acceptance tests
are in [BIOSECURITY_GOVERNED_MODULE.md](design/BIOSECURITY_GOVERNED_MODULE.md).
Apply the same rule to other module flows that still require separate browser
writes and evidence calls.

## Recommended Next Step

Start with a focused mobile offline scan rebuild, because it uses the highest-value prototype concepts while leaning on the stronger current server contracts:

1. Add mobile dependencies for camera, location, file-system, network status, and SQLite.
2. Create a mobile scan screen that submits to `process-officer-scan` online.
3. Add a local queued scan store with device capture timestamp and retry attempts.
4. Add a sync worker that replays queued scans with `offline_queued` and `synced_at`.
5. Only then add current-schema offline data packaging and provisional local compliance.

## GitLab Follow-Up

This audit measured the accessible GitHub prototypes, this checkout, prior Bob-derived GitLab extraction artifacts, and a small set of live Bob/GitLab searches/reads using the Codespace grandmaster test credentials. The service-role key alone is rejected as `Unauthorized`, so future live Bob reads must likewise use an authenticated `grand_master` user JWT.

Future Bob reads should target the unresolved GitLab surfaces rather than rereading already complete files:

- `apps/web/src/shells/ScanShell.tsx` remaining middle window if needed; lines 1-240 and 240-275 were read live in this pass.
- `apps/web/src/shells/ClientShell.tsx` — role routing proves it exists in the GitLab build, but nested client behavior was not read.
- Remaining `DispatchConsolePage.tsx` windows outside the captured major sections, especially completion/assignment writes and `PreArrivalDossier` integration.
- Full `WelfareAlertsPage.tsx`, because only partial search-derived evidence is recorded.
- `PreArrivalDossier.tsx`, `NotificationsBell.tsx`, `ReportButton.tsx`, and `BobPanel.tsx`. `FieldSafetyBar` and `PttBar` were not found as separate component files; they appear inline or referenced through shell/source text.
- Any GitLab mobile/offline paths if present: `apps/mobile`, `Expo`, `SQLite`, `offline`, `sync-organization-data`, `uploadQueue`.
- Evidence spine terms: `evidence_media`, `photo_urls`, `hash`, `retention`, `court-ready`.

For each hit, verify whether it is a real read/write/call edge or only a textual reference before adding it to the rebuild backlog.