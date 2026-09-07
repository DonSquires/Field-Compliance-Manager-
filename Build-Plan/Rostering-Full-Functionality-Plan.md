# Full Rostering Build Plan

Date: 2026-09-07

## Verified foundation

The roster domain is already anchored to these schema entities:

- `roster_slots`: planned typed assignments and lifecycle state.
- `shifts`: materialized field execution, actual timestamps, completion state.
- `timesheets`: derived/manual payroll time and approval state.
- `shift_templates`: recurring roster generation.
- `staff_availability` and `leave_requests`: conflict controls.
- `rate_rules`, dispatch pay lines, and travel-distance resolution: commercial/pay evidence.
- `shift_swaps`, break entitlement, and break start RPCs: now exposed through the web workflow; direct swap notifications are live.

Existing governed writes include `create_roster_slot`, `update_roster_slot`, `materialize_roster_slot`, `manage_roster_slot`, `reassign_roster_slot`, `respond_to_roster_slot`, `offer_overtime_by_seniority`, `complete_officer_shift`, `review_branch_timesheet`, `review_timesheet`, and payroll export.

## Atlas findings

Live Atlas marks `roster_slots`, `shifts`, `timesheets`, and `shift_templates` as present and wired. Static callers include `RosterOperationsPage`, `OfficerSchedulePage`, `OfficerTimesheetPage`, `RosterHRPage`, materialization, completion, commercial readiness, overtime, shift swaps, breaks, and travel pay resolution.

Atlas does not infer `exercised`; browser acceptance must prove each flow. The direct `roster_slots` flow-reach query returned no rows, so Atlas refresh/seed must be run after new lifecycle callers are exercised. Do not treat the existing `references` inventory as proof of live runtime flow.

## Product lifecycle

`demand/template -> draft slot -> published slot -> officer response -> accepted slot -> active shift -> break/travel/time evidence -> completed shift -> derived timesheet -> branch review -> payroll approval -> payroll export`

Every transition must include expected state, actor authority, reason where material, audit event, notification behavior, and downstream payroll/report impact.

## Build phases

### Phase 1: Expose existing governed capabilities

1. Add admin roster actions for copy-to-draft, repeat date range, draft edit, publish, recall, reassign, cancel, and batch publish.
2. Add officer actions for accept/decline, open-shift claim, swap request, swap cancellation, and swap decision receipt.
3. Add break controls using `get_shift_break_entitlement` and `start_shift_break`, with active-shift validation and visible receipt.
4. Add travel/time evidence to the officer shift workflow using existing geofence/GPS and rate resolution paths.
5. Add browser tests for every transition and terminal-state restriction.

### Phase 2: Timesheet correction and approval loop

1. Show derived work, actual timestamps, adjustments, breaks, travel, and pay-line evidence together.
2. Allow authorised managers to correct submitted time through a governed correction RPC with before/after values and reason.
3. Support branch check, return for correction, resubmission, corporate approval, approval return, and reapproval.
4. Block approval when unresolved dispatch pay-line exceptions exist.
5. Lock paid/exported timesheets and expose an audited correction route rather than direct editing.

### Phase 3: Planning intelligence and workforce safeguards

1. Repeat templates across date ranges with preview and conflict counts.
2. Add rest/fatigue, skills, credential, leave, availability, and overlapping-work warnings before publish.
3. Add workload, overtime, labour-cost, client-billing, and margin previews.
4. Add notifications for assignment, update, cancellation, swap, offer expiry, and approval decisions.
5. Add no-show, late, absence, and coverage escalation workflows.

### Phase 4: Human acceptance and release hardening

1. Desktop and mobile browser journeys for every lifecycle path.
2. RLS/RPC authorization tests for provider, branch, manager, officer, and corporate payroll roles.
3. Re-run Atlas capability/edge refresh after exercised flows.
4. Compare Atlas flow reach with schema writers and report dormant or references-only claims.
5. Apply migrations, run full tests, capture screenshots, and publish rollback notes.

## First implementation slice

Start with Phase 1 break and swap exposure because the database contracts already exist and the current UI has no callers. Do not add duplicate tables. Add only missing UI adapters, friendly error handling, receipts, focused browser fixtures/tests, and Atlas refresh evidence.

### Progress: active-shift breaks complete

- `OfficerSchedulePage` now loads break entitlement for an `in_progress` shift.
- Officers can start a governed rest or meal break and end the active break.
- The schedule shows taken versus required rest/meal breaks.
- The browser acceptance flow covers start and end receipts on desktop and mobile.
- No migration was required; the existing `get_shift_break_entitlement`, `start_shift_break`, and `end_shift_break` RPCs are used.

Next slice: add full browser coverage for return-for-correction and timesheet reapproval.

### Progress: shift-swap request/review in progress

- Added the missing governed `request_shift_swap` RPC for officer-originated open/direct requests.
- Officers can submit an open swap request with a required reason from My Schedule.
- HR loads pending swaps and can approve or decline them through `review_shift_swap`.
- Approval is restricted to unstarted shifts and transfers linked roster ownership through the existing review RPC.
- Browser coverage now exercises the officer request path; the migration must be applied before live use.

### Progress: correction loop started

- Added `resubmit_rejected_timesheet_from_work` for owner-only correction and resubmission.
- Rejected timesheets recalculate derived work, replace their work ledger, clear the rejection, and return to `submitted` with an audit event.
- The officer form now shows `Resubmit corrected timesheet` for the matching rejected period.
- The remaining approval-loop work is browser coverage for manager return, officer correction, branch check, and corporate reapproval, plus live migration application.

### Progress: completed-shifts-only timesheets complete

- `get_officer_timesheet_work` now includes only completed shifts with actual timestamps and standalone completed dispatch jobs.
- Accepted, in-progress, and active partial work no longer generates payable timesheet hours.
- Linked dispatch jobs remain excluded when already represented by a completed shift, preventing double counting.
- Migration `20260907001700` is applied and verified in live Supabase.

### Progress: manager time correction complete

- Added `correct_timesheet_hours` with expected-status protection, range validation, mandatory reason, and immutable before/after audit metadata.
- HR can manually edit actual and overtime hours while a timesheet is submitted or branch-checked.
- Corrections return the timesheet to `submitted`, clear branch review state, and require the normal review path again.
- Migration `20260907001800` is applied and verified in live Supabase.

### Progress: planning and attendance controls complete

- Admins can copy a selected roster assignment one week forward as an unpublished draft, preserving officer, work unit, hours, and notes for review.
- The copy action reuses governed `create_roster_slot` validation for overlap, leave, fatigue, and work-readiness rules.
- Officers can start accepted/published/scheduled shifts from My Schedule; GPS coordinates are captured when available and the start is audited by `start_officer_shift`.
- Fixed the roster inspector stacking order so header actions remain clickable while an assignment is open.

### Progress: direct swaps and notifications complete

- Officers can select an eligible work-ready replacement officer or leave a swap as open coverage.
- The request RPC validates organization, readiness, overlap, shift state, and duplicate pending requests.
- Replacement officers receive a roster notification for direct requests.
- Original and replacement officers receive approval/decline notifications after manager review.
- Migration `20260907001900` is applied and verified in live Supabase.

### Progress: roster change notifications complete

- Assignment publication, reassignment, cancellation, timing changes, and materialized shift ownership/status changes now notify the affected officer through the existing notification center.
- Notifications include schedule links and deduplicated roster/shift change keys.
- Migrations `20260907001900` and `20260907002000` are applied and verified in live Supabase.

### Progress: attendance exception queue complete

- Added `get_roster_attendance_exceptions` over the canonical `shifts` table.
- Admin roster now surfaces late starts after a 15-minute grace period and active shifts that overrun their scheduled end.
- No duplicate attendance ledger was introduced; actual start/end remains governed by the shift record and clock-in/completion RPCs.
- Migration `20260907002100` is applied and verified in live Supabase.

### Progress: template preview complete

- Added `preview_roster_from_templates` with a bounded 93-day planning window.
- Admins can inspect active templates, candidate slots, duplicate existing slots, and net new drafts before generation.
- Generation remains a separate explicit action; preview does not mutate roster data.
- Migration `20260907002200` is applied and verified in live Supabase.

### Progress: bulk publish preview complete

- Added `preview_batch_publish_roster_slots` with no data mutation.
- Admins can see draft count, leave conflicts, unassigned slots, and field-shift materialization count before batch publish.
- The existing batch publish action remains explicit and separate from preview.
- Migration `20260907002300` is applied and verified in live Supabase.

### Progress: date-range repeat planning complete

- Added `repeat_roster_slot_range` for governed draft repetition across up to 93 days.
- Leave-conflicted and overlapping days are skipped and returned as separate counts.
- Admins can choose a date range from the selected assignment without auto-publishing.
- Fixed quick-action stacking so repeat controls remain clickable on mobile with the assignment inspector open.
- Migration `20260907002400` is applied and verified in live Supabase.

### Progress: batch publish failures durable

- Batch publish now records each materialization failure with slot, work unit, client request ID, and database reason in the audit log.
- The admin receipt queries those failures and reports the retained failure count instead of silently swallowing the error.
- The public batch publish RPC signature remains compatible with existing callers.
- Migration `20260907002500` is applied and verified in live Supabase.

### Progress: attendance exception acknowledgment complete

- Added governed `acknowledge_roster_attendance_exception` for late-start and active-overrun cases.
- Admin notes are required and written to the audit log.
- The assigned officer receives a roster notification linked to the schedule.
- Migration `20260907002600` is applied and verified in live Supabase.

### Progress: direct swap browser proof complete

- Added a human browser journey for selecting an eligible replacement officer and submitting a direct swap.
- Payload coverage verifies `swap_type = direct` and the selected replacement staff profile.
- Open swap fallback remains covered separately.

### Progress: approval-loop browser proof improved

- HR browser coverage now proves the manager return-for-correction leg for branch-checked time.
- Officer browser coverage proves rejected-period correction and resubmission.
- Existing HR coverage proves branch check and final approval separately.
- A single cross-role browser context spanning manager -> officer -> manager remains a release-test gap.

### Progress: notification-center browser proof complete

- Officer browser coverage now displays a roster notification, filters unread items, marks it read, and follows the schedule-linked notification action on desktop and mobile.
- Direct swap request payload proof and open-swap fallback are both covered.
- A shared-session manager approval -> officer notification -> officer schedule refresh journey remains a release-environment gap because the current fixtures isolate auth sessions.

### Progress: new migration authorization guards complete

- Added static regression guards for the 20260907 roster migrations.
- Guards cover authenticated/service-role grants, actor/administrator checks, expected-state protections, bounded preview/repeat windows, audit writes, and notifications.
- Full unit coverage is now 170 files and 696 tests.

### Progress: travel evidence review visibility complete

- Pay Review now shows distance kilometres and the provenance reason for every dispatch pay line, including explicit missing-distance states.
- Existing rate resolution remains the source of truth; the UI does not fabricate travel claims.
- HR desktop/mobile flows and the full unit suite remain green.

### Atlas follow-up

- The current repository dry-run inventory is 823 capabilities and 2,484 edges.
- Live Atlas apply is intentionally pending because the generator detected 108 retirements and refused to proceed without an explicit large-retirement override.
- Do not force that override until the retirement list is reviewed against the live capability map; the roster work remains deployed and verified independently.

## Plan audit: remaining gaps

The following items are still genuinely incomplete or only partially proven:

- **Repeat planning:** single-slot copy exists; date-range repeat/copy with per-day conflict preview is not built.
- **Bulk publish:** preview exists, but materialization failures are still swallowed by the existing batch publish RPC and need a durable failure result per slot.
- **Timesheet approval loop:** manager correction and officer resubmission exist, but there is no dedicated browser journey proving return -> correction -> branch check -> corporate approval -> corporate return -> re-correction -> reapproval.
- **Direct swap proof:** direct replacement selection is implemented, but browser coverage currently proves the open-swap path, not direct approval plus replacement notification delivery.
- **Attendance exceptions:** late-start and active-overrun visibility exists; absence/no-show resolution, escalation ownership, and notification creation are not yet implemented.
- **Travel evidence:** rate resolution and distance pay lines exist in schema; the officer/admin UI does not yet present travel/break/pay-line evidence together before approval.
- **Skills matching:** work readiness and credential checks exist, but no canonical skill-to-work-unit requirement contract exists, so skill matching must not be claimed complete.
- **Credential picker filter:** the roster board displays credential risk and server-side write guards remain authoritative, but the compressed create dialog still lists all `workReady` staff instead of filtering the picker to `credentialRisk = clear`; refactor that dialog before adding the UI filter.
- **Credential assignment guard:** create, copied-draft, and draft-edit submission now block non-clear credential states before the governed write; the picker refactor remains a UX follow-up.
- **Credential assignment notice:** the create workflow now explicitly tells operators that risk-state staff remain visible for context but cannot be submitted; the compressed picker refactor remains the only UX follow-up.
- **Authorization proof:** the full provider/branch/officer/corporate authorization matrix still needs explicit RPC tests for the new migrations.
- **Atlas:** dry-run inventory is current, but live refresh remains blocked by the 108-row retirement safety gate and needs a reviewed retirement list.

## Acceptance criteria

- A manager can create, copy, edit, publish, recall, reassign, and cancel a planned slot.
- An officer can receive, accept, decline, swap, start/end an allowed break, and see every receipt.
- A completed shift cannot be edited through the planning UI.
- A timesheet can be submitted, returned with a reason, corrected, re-submitted, branch checked, approved, returned, and re-approved.
- Travel and hourly pay evidence resolves from governed rate rules and is visible before payroll approval.
- All terminal and correction transitions are append-only in audit history.
- No raw backend errors, silent writes, or untracked schema-only capabilities remain in the tested path.
