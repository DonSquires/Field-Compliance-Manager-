# Officer Portal and Admin Data-Flow Audit, 2026-11-08

## Scope and method

The production target is [the officer schedule](https://www.fcmanager.co.nz/officer/schedule). Production alias verification returned `0f87882cc2b1a7a42e47e28fa92d77392a4a2206` after PR #427 merged at 2026-11-08 14:17 UTC. The earlier private-Oracle proxy repair is deployed. This audit used scoped, read-only database/Atlas diagnostics and synthetic browser fixtures; no real user session, password, business-record write, timesheet correction, review, or attendance mutation was used.

The authenticated production browser could not be operated from this session. Human screenshots are evidence of visible UI state, not proof that the current authenticated page was reloaded after deployment.

## Findings

### 1. Start is still blocked before attendance

- **Before:** the rostered overnight static shift is `accepted`, has one active site contract, and its site boundary is active, verified, and valid.
- **During:** the supplied UI reports that private Oracle review is unavailable. The briefing function calls the private Oracle before the static-start RPC. A synthetic authenticated review through the deployed proxy returns a checked `gpu_workstation` receipt, but that does not reproduce this shift's private briefing payload. The current failure's per-request cause is unknown; error logs intentionally withhold narrative and expose only a generic failure.
- **After:** live state still has no `actual_start`, static arrival/departure action, or submitted debrief. The last scoped position check found the fix inside the rostered site's attendance boundary and linked to this accepted shift. A GPS breadcrumb is not a start or arrival receipt.
- **Safe action:** refresh and retry **Start shift** for the original rostered assignment. Do not start an unscheduled shift or infer/backdate attendance. If Oracle still fails, contact operations; do not bypass the briefing privacy gate.

### 2. GPS place context is bound to another agreement, not the rostered site

- **Observed:** direct attendance geometry says the assigned site is verified and the latest fix is within its attendance radius. The general operational resolver returns a resolved place, but not the rostered site. The service-context hook only marks a match when the resolved Site/Zone belongs to its selected agreement.
- **Agreement state:** the context provider's default agreement is not the agreement location on the current shift. The default has 0 active Site links and 2 active Zone links; the shift contract has 1 Site link and no Zone link. This explains the screenshot's “No verified service place” context while attendance can still recognize the assigned site.
- **User/job:** on the roster page, the banner can imply no usable place despite the shift's verified site. Canon says geofence is context, not module access, but static attendance evidence is separately checked.
- **Decision question:** should the officer shell automatically select the current rostered shift's agreement/site, or keep the independently selected agreement and label that the location belongs to another agreement? Automatically following the shift is clearer during work; retaining independent selection avoids changing report/map scope without user intent. No behavior change was made pending this product decision.

### 3. Admin Officer was missing from the activity-timeline subject picker

- The signed-in field-working identity has role `admin_officer`. The activity timeline UI queried only `officer` and `scan_operator`, although the timeline RPC allows an authorized organization admin to read the subject and canon defines `admin_officer` as admin-tier.
- Fixed and deployed in [PR #427](https://github.com/DonSquires/Field-Compliance-Manager-/pull/427): include `admin_officer` in the picker. A synthetic desktop browser test verified the officer appears and the expected ID is sent to `get_officer_activity_timeline`. The live audit-writing timeline RPC was not invoked.

### 4. Site-only reports were omitted from zone-scoped admin views

- `FieldReportsPage`, Field Operations follow-up counts, and Admin Hub follow-up counts filtered officer reports only by `zone_id` when the selected agreement had Zones. Reports anchored only to a contracted Site therefore disappeared in a mixed Site+Zone agreement.
- Fixed and deployed in [PR #427](https://github.com/DonSquires/Field-Compliance-Manager-/pull/427): the three report reads now use a shared Site-OR-Zone agreement-place filter. The unchanged status, organization, and governed review-RPC checks remain in place.
- A synthetic site-only report was visible in the admin review queue in both desktop and phone browser tests with a mixed Site+Zone agreement.
- Production has 3 recent submitted officer reports: 2 H&S records are linked to a Site and shift but have no Zone; 1 incident report is not linked to a shift or Site. All 3 remain submitted/unreviewed at the time checked. Private narratives were not inspected.

### 5. A submitted timesheet snapshot no longer matches current shift sources

- The latest submitted period timesheet (`2026-11-02` through `2026-11-06`) stores 91.55 work-derived hours from 2 `timesheet_work_entries`, both shift sources, and is still `submitted`. It has no payroll export batch.
- The same Auckland-local period now contains 3 completed shifts with 99.56 gross hours, 0 unpaid-break rows, and no standalone completed dispatch jobs. One shift source was updated after submission; the post-submission audit actions include `shift_record_corrected` and `roster_attendance_exception_acknowledged`.
- `review_branch_timesheet` checks submitted status, actual hours and dispatch-pay blockers but does not compare the source ledger to current shift/break sources. `guard_timesheet_payroll_evidence` protects exported values and payroll corrections, but does not invalidate a submitted snapshot when a source shift changes.
- The 8.01-hour difference is therefore an unresolved source-snapshot discrepancy, not an authorized adjustment. No timesheet mutation or approval/export was made. Do not branch-check or export this period until an authorized reviewer reconciles it through the governed correction/resubmission path. A stale-source approval guard should be designed and migration-tested as a separate payroll-integrity change.
- Ledger follow-up confirms 2 saved shift entries versus 3 current completed shifts; one completed shift is missing from the snapshot, and one source changed after submission. The 2 saved entries total 5,493 minutes. No standalone completed dispatch source exists in this period, and no export batch is linked.

## Verified data paths

- **Attendance:** `OfficerSchedulePage` calls the safety briefing, then `start_officer_static_shift`; the transaction calls `start_officer_shift` and records static arrival. The end flow checks readiness, records the debrief, then `complete_officer_static_shift` records departure and completes the shift. Live attendance receipts are still absent.
- **GPS/live map:** `OfficerShell` writes `record_officer_breadcrumb`; live map reads `get_live_officer_positions`, which uses `officer_gps_log.detected_zone_id` and `shifts.zone_id`. The earlier suspected `officer_gps_log.zone_id` mismatch was a false alarm: the UI uses the RPC and the SQL uses the real column.
- **Reports/admin review:** `OfficerFieldReportPage` calls `submit_officer_field_report`; a database trigger inherits an unambiguous shift Site/Zone. Admin Field Reports reads `officer_field_reports` and uses `review_officer_field_report`, which records review and notification provenance. Current submitted rows remain unreviewed.
- **Timesheets/payroll:** officer timesheets map through `staff_profiles.user_id`; the current staff/login link matches. The queue reads `timesheets` and source entries; branch review uses `review_branch_timesheet`; payroll export remains a later, separately guarded step. Current source snapshot is stale as described above.
- **Access:** Atlas maps the timeline page to `get_officer_activity_timeline`, report submission to `submit_officer_field_report`, and live map to `get_live_officer_positions`. `get_officer_activity_timeline` returns a read with an access audit; it was not invoked live. Capability flags are map evidence, not invocation evidence.

## Verification

- Production Vercel alias matched merged commit `0f87882cc2b1a7a42e47e28fa92d77392a4a2206` at verification.
- Complete web unit suite before the final targeted browser additions: 444 files and 2,315 tests passed. Focused admin/timeline/place-filter suite: 5 files, 33 tests passed.
- Web lint/type checks and production build passed. Root shift-start and VPS-route tests: 8 passed.
- Synthetic admin-officer timeline browser check: desktop passed. Site-only report visibility with mixed Site+Zone agreement: desktop and phone passed. Protected PR #427 runtime, web, and offline-browser checks all passed; Vercel serves the merged SHA above.
- The broad Field Operations browser suite reported 10 failures and 2 passes. Failures included stale screenshot baselines, vehicle-search input timeouts, and a selected-text color assertion. Baselines were not updated. The separately launched full officer-spec run had no captured report and is not claimed as passing.
- Screenshots for the synthetic report path and the supplied production schedule view were inspected. No real-device/background-GPS proof is available.

## Outstanding human and engineering actions

1. Human-operated retry at [the production officer schedule](https://www.fcmanager.co.nz/officer/schedule); confirm that private briefing delivery succeeds, then verify the exact rostered shift's `actual_start` and static arrival receipt. Share only redacted result status.
2. Decide whether field-officer place context should follow the assigned shift contract or remain independently selected, with an explicit mismatch explanation.
3. Reconcile the submitted Nov 2–6 timesheet snapshot before any branch review or payroll export; do not backdate attendance.
4. Design and test a stale-source guard before allowing submitted timesheets to advance after source shifts or breaks change.
5. Keep the resolved admin-officer picker and Site-or-Zone report filters in production. The stale submitted timesheet source snapshot still requires a separate, migration-tested blocker and authorized reconciliation.
