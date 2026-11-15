# Workforce Timesheet Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare staff timesheets from completed work on an explicitly configured employer pay cycle, then let staff respond to rejection and authorized payroll staff correct and decide the result.

**Architecture:** Keep the existing period-based `timesheets` header, `timesheet_work_entries` evidence, review RPCs, and shift-correction writer. Add an employer-owned pay-cycle setting, a private idempotent scheduled reconciler with visible receipts, and append-only staff replies. Update the existing web and mobile timesheet surfaces; do not build a parallel ledger or change payroll export, cost posting, or invoicing.

**Tech Stack:** Supabase Postgres imperative migrations, private `ops` functions and `pg_cron`, React/TypeScript, Node `node:test`, Playwright.

**Spec:** [Three-Area Operating Model and Background Automation](../specs/2026-11-15-three-area-operating-model-design.md)

## Global Constraints

- Keep a single service provider for the current phase and multiple client organisations. Revisit multi-provider SaaS only after this product is working and the owner reopens that scope.
- Auto-apply routine actions only under explicit, pre-approved rules. Authorised people retain review, edit, cancel, and approval controls; exceptions and high-impact decisions require human handling.
- Preserve the current role/tenant checks and client-disclosure boundaries. Staff wages and provider-private commercial data are not exposed to clients.
- Keep staff employment ownership separate from the operational place where staff deliver work.
- Keep one authoritative workflow writer for each consequential state. UI cleanup alone is not evidence that a background action is wired or safe.
- The phrase “auto-apply routine actions” does not authorize automatic release of payroll funds, acceptance of a quote, sending an invoice, employment decisions, changes to client/place ownership, disclosure of client data, or other high-impact actions.
- Keep one authoritative record per real business concept. Reconcile overlapping organisation and place representations only after tracing their actual writers, readers, permissions, history, and downstream uses.
- Use configurable catalogues and rules for services, place types, pay, billing, and workflow options where a governed data source exists. Do not add another UI-only hard-coded catalogue.
- Preserve historical, approved, paid, and exported records; route corrections through audited, authorized writers.
- Do not hand-edit `supabase/schema.sql` or Atlas; refresh them only through their governed scripts after real changes.
- Never mark VB-15 Ready while any Approve or Cancel control is a placeholder or success-shaped no-op. Staff cannot approve their own timesheet.

## Review Focus

1. Missing, disabled, or invalid cycle settings must block generation and show the payroll administrator the exact setup action; test no generation without settings and reject invalid time zones/cycles in Task 1.
2. A missed scheduler run, retry, or concurrent run must not duplicate a timesheet or work minutes; test idempotent recovery and duplicate suppression in Task 2.
3. A work source changed after preparation or review must be surfaced as stale instead of silently replacing the reviewed evidence; test source-version conflict handling in Task 2.
4. A staff reply must not replace the rejection reason or change official hours/status, and another staff member must not see or submit it; test ownership, reason preservation, and duplicate request behavior in Task 3.
5. A reviewer without employer payroll authority, or the branch reviewer attempting final approval, must not complete the decision; test both authorization boundaries and visible failures in Task 4.

## Verified Baseline and Scope

- `timesheets` and `timesheet_work_entries` are present. The latter has a unique index on `(timesheet_id, source_type, source_id)`.
- Atlas has direct `reads`/`writes` edges for the timesheet review, correction, and work-source RPCs, and direct UI readers. `timesheets` is marked `present=true`, `wired=true`, and `exercised=true`, updated 2026-11-09. That `exercised` value conflicts with repository guidance that the field is unpopulated; do not treat it as invocation evidence. The live flow trace showed UI/RPC readers and writers, while FK reach remains structural only.
- `submit_officer_timesheet_from_work` currently creates a submitted sheet only after an officer supplies a period and calls submit; it accepts an adjustment. The web and mobile officer surfaces both expose this submit/adjustment path.
- `recover_scheduled_timesheet` is an audited, manual administrator recovery from reviewed scheduled rows. It is not a background actual-attendance generator and must not be called by the new scheduler.
- `review_timesheet` already enforces employer administrator authority, expected status, rejection notes, and the branch-reviewer separation rule; it writes an audit event and decision notification.
- `correct_timesheet_shift_hours` already preserves the original attendance, requires an audited reason and optimistic source versions, blocks finalized payroll, and returns a corrected rejected sheet to `submitted`. Reuse it for shift corrections rather than creating a parallel correction writer.
- The `timesheet_work_entries` select policy currently uses `accessible_org_ids()`, while Atlas shows its application readers are scoped RPCs. The staff detail path must not depend on direct organization-wide reads; constrain direct staff reads to their own timesheet lines and preserve administrator access.
- No employer payroll-cycle setting or separate staff-reply record was found in the inspected live schema. `TimesheetsPage` has period and shift review views; its per-shift rows do not expose the receiving organisation/place. The existing finance writer is not a loaded-cost allocation model and is outside this slice.
- The active VB-15 draft was reported Ready despite two changed files, no PR, and no-op Approve/Cancel behavior. Before execution, inspect those exact files and reconcile them with this plan; do not accept that session as complete until every consequential action has a real authorized path.

## Scope

**In scope:** Employer pay-cycle configuration; background preparation and reconciliation from completed work; per-period and per-source receipts; staff read-only timesheet view and append-only reply; payroll-admin shift correction and final review; role-safe place/recipient context; desktop and mobile user-state verification.

**Out of scope:** Replacing the broader three-area navigation; employer payroll calculations or export changes; loaded labour-cost modelling/posting; quote, invoice, or payment changes; client access changes; schema consolidation; automatic payroll approval or release.

**Proposed pay cycles for review:** weekly, fortnightly, four-weekly, or monthly. Require an anchor date and explicit IANA time zone; do not enable generation until configured. Monthly periods use calendar-month boundaries anchored on the first day of a month. Change this proposal before implementation if it does not match the employer's actual payroll rules.

---

### Task 1: Configure Employer Pay Periods

**Files:**
- Create: migration from `supabase migration new timesheet_pay_period_settings`
- Modify: `apps/web/src/pages/TimesheetsPage.tsx`
- Create: `test/timesheet-pay-period-migration.test.js`
- Create: `test/timesheet-pay-period-postgres.test.js`
- Create: `apps/web/e2e/timesheet-pay-period-settings.spec.ts`

**Interfaces:**
- Consumes: `organizations`, `is_timesheet_payroll_admin(uuid)`, current `TimesheetsPage` route and auth context.
- Produces: `public.timesheet_pay_period_settings` with one row per employer organization; `public.set_timesheet_pay_period_settings(p_organization_id uuid, p_cycle_kind text, p_anchor_date date, p_time_zone text, p_generation_enabled boolean, p_expected_revision integer)`; the existing timesheets workspace gains an employer-only pay-schedule setup/status panel.

- [ ] **Step 1: Write failing tests** named `rejects invalid payroll cycle and time zone`, `requires a complete schedule before enabling generation`, and `rejects non-admin and stale-revision writes`. Assert invalid cycles/zones and unauthorized/stale writes fail, and settings remain disabled until a valid explicit save. Have `timesheet-pay-period-migration.test.js` conditionally require its PostgreSQL test when `BOB_TEST_POSTGRES === '1'`.
- [ ] **Step 2: Run `node --test test/timesheet-pay-period-migration.test.js`** and verify the new assertions fail against the current schema.
- [ ] **Step 3: Create the migration** with `supabase migration new timesheet_pay_period_settings`; add the organization-keyed settings table, constraints, admin-scoped RPC, audit event, and explicit grants. Use the proposed cycle values above; do not default the cycle, anchor, or time zone.
- [ ] **Step 4: Add the schedule panel** to `TimesheetsPage.tsx`. Display unset/disabled/ready states, the configured cycle and next period, permission failures, save progress, and a confirmed receipt. Do not show generation as enabled after an unconfirmed save.
- [ ] **Step 5: Run the Node test and PostgreSQL test** with `node --test test/timesheet-pay-period-migration.test.js` and `$env:BOB_TEST_POSTGRES='1'; node --test test/timesheet-pay-period-migration.test.js; Remove-Item Env:BOB_TEST_POSTGRES`; verify invalid configuration, unauthorized writes, and stale revisions fail explicitly.
- [ ] **Step 6: Run `$env:E2E_OFFLINE='1'; npx playwright test e2e/timesheet-pay-period-settings.spec.ts; Remove-Item Env:E2E_OFFLINE` from `apps/web`**; verify an administrator can save settings, a non-admin cannot edit them, and unset settings show a clear blocked state.
- [ ] **Step 7: Commit** the migration, page, and tests as one independently reviewable change.

### Task 2: Generate and Reconcile Period Timesheets

**Files:**
- Create: migration from `supabase migration new timesheet_period_generation`
- Modify: `supabase/schema.sql` only by regenerating from the live catalog after migration
- Create: `test/timesheet-period-generation-migration.test.js`
- Create: `test/timesheet-period-generation-postgres.test.js`

**Interfaces:**
- Consumes: `timesheet_pay_period_settings`, `get_officer_timesheet_work`, `timesheet_work_entries`, and the current `timesheets` status model.
- Produces: a private `ops.generate_due_timesheet_periods()` scheduled worker; a private/idempotent shared source-calculation helper if required to reuse the existing completed-work selection; and `public.timesheet_generation_runs`, keyed uniquely by organization, staff, and period, with status, source count/version, resulting timesheet ID, attempt information, and bounded failure detail. Missing or disabled settings are visible in the Task 1 setup panel and are not given a fabricated period-level run receipt.

- [ ] **Step 1: Write failing PostgreSQL tests** named `prepares one sheet from completed work after period close`, `repeated and concurrent ticks create one header and one line per source`, `skips missing or disabled settings and records legacy-overlap blockers`, and `marks changed sources stale without overwriting reviewed evidence`. Have `timesheet-period-generation-migration.test.js` conditionally require its PostgreSQL test when `BOB_TEST_POSTGRES === '1'`.
- [ ] **Step 2: Run `$env:BOB_TEST_POSTGRES='1'; node --test test/timesheet-period-generation-migration.test.js; Remove-Item Env:BOB_TEST_POSTGRES`** and confirm the current officer-triggered submission path does not satisfy automatic preparation.
- [ ] **Step 3: Create the migration** with `supabase migration new timesheet_period_generation`. Keep generation functions in the non-exposed `ops` schema, restrict execution to the scheduler/service role, set a safe `search_path`, and add the run/receipt table with tenant-safe read policies.
- [ ] **Step 4: Implement period calculation and preparation** from completed, time-bearing work selected by the existing work-source logic. Preserve source IDs, timestamps, break treatment, and a source-version fingerprint. Do not derive payable time from scheduled rows alone or silently apply officer adjustments.
- [ ] **Step 5: Make retries safe.** Serialize per staff-period, reuse an exact existing eligible sheet, and write `timesheet_work_entries` idempotently. If a legacy overlap or a changed source prevents safe reuse, record a visible blocked/stale run; never overwrite approved, paid, or exported evidence.
- [ ] **Step 6: Schedule the worker** using the repository's existing `ops` plus `cron.schedule_in_database` pattern. Enumerate only enabled settings and run only after the configured local period has closed; keep missing/disabled states observable in the setup panel. Keep the function out of public client grants.
- [ ] **Step 7: Record an audit receipt** for each prepared period, including the setting revision, period, source count, and resulting timesheet ID. Use the existing `submitted` state expected by `review_timesheet`, but label it “Ready for payroll review” in the UI; identify background preparation in provenance rather than claiming the officer submitted it.
- [ ] **Step 8: Run `node --test test/timesheet-period-generation-migration.test.js` and `$env:BOB_TEST_POSTGRES='1'; node --test test/timesheet-period-generation-migration.test.js; Remove-Item Env:BOB_TEST_POSTGRES`**; verify missing configuration, time-zone boundary/DST behavior, missed-run recovery, concurrency, stale sources, and immutable finalized sheets.
- [ ] **Step 9: Commit** the migration and tests. Do not apply it to a live project as part of plan execution without the normal release approval.

### Task 3: Make Staff Timesheets Read-Only With Separate Replies

**Files:**
- Create: migration from `supabase migration new timesheet_staff_responses`
- Modify: `apps/web/src/pages/OfficerTimesheetPage.tsx`
- Modify: `apps/web/src/lib/officerTimesheetWork.ts`
- Modify: `apps/mobile/src/components/OfficerTimesheetPanel.tsx`
- Modify: `apps/mobile/src/lib/officerTimesheetWork.ts`
- Modify: `apps/web/e2e/officer-timesheet.spec.ts`
- Create: `test/timesheet-staff-reply-migration.test.js`
- Create: `test/timesheet-staff-reply-postgres.test.js`

**Interfaces:**
- Consumes: generated `timesheets`; existing staff ownership checks and notification helper.
- Produces: append-only `public.timesheet_staff_responses`; `public.reply_to_rejected_timesheet(p_client_request_id uuid, p_timesheet_id uuid, p_response text)`; and `public.get_timesheet_detail(p_timesheet_id uuid) RETURNS jsonb`, which returns work lines, decision history, and replies only to the linked staff member or an authorized reviewer.

- [ ] **Step 1: Write failing tests** named `staff can reply only to their own rejected sheet`, `reply does not change rejection reason or official hours`, `same request ID returns the same receipt`, and `staff cannot read another employee's work entries`. Assert changed-payload reuse is rejected. Have `timesheet-staff-reply-migration.test.js` conditionally require its PostgreSQL test when `BOB_TEST_POSTGRES === '1'`.
- [ ] **Step 2: Run `node --test test/timesheet-staff-reply-migration.test.js`** and verify there is no existing reply record or reply RPC.
- [ ] **Step 3: Create the migration** with `supabase migration new timesheet_staff_responses`. Store each response separately and append-only; allow reads only to the linked staff member and authorized employer payroll administrators; allow writes only through the ownership-checking RPC. Replace organization-wide direct staff reads of `timesheet_work_entries` with own-timesheet/admin scope; keep branch review on its existing scoped RPC path. Implement `get_timesheet_detail` as the staff-safe reader for work lines and decision/reply history. Notify the authorized payroll queue using the existing notification path.
- [ ] **Step 4: Replace the web submit/adjust form** with the configured period's generated record and source evidence. Remove officer approval, official-hours editing, and manual adjustment submission. Show an append-only reply form only for rejected sheets; show the rejection reason and prior replies separately.
- [ ] **Step 5: Apply the same behavior to the mobile panel.** Retain loading, empty, retry, permission, and safe error states. Do not add a mobile test framework solely for this change; verify on a supported simulator/device in Task 5.
- [ ] **Step 6: Update Playwright tests** so staff see generated sheets without submitting them, cannot approve or change official hours, can reply to a rejection, and see an explicit error if the reply receipt is not confirmed.
- [ ] **Step 7: Run `node --test test/timesheet-staff-reply-migration.test.js` and `$env:E2E_OFFLINE='1'; npx playwright test e2e/officer-timesheet.spec.ts; Remove-Item Env:E2E_OFFLINE` from `apps/web`**; verify a reply never changes the rejection reason or timesheet decision.
- [ ] **Step 8: Commit** the migration, web/mobile changes, and tests as one reviewable change.

### Task 4: Complete the Payroll Administrator Review Path

**Files:**
- Modify: `apps/web/src/pages/TimesheetsPage.tsx`
- Create: migration from `supabase migration new timesheet_shift_attribution` to replace `get_timesheet_shift_rows`
- Modify: `test/timesheet-final-approval.test.js`
- Create: `test/timesheet-shift-attribution-migration.test.js`
- Create: `test/timesheet-shift-attribution-postgres.test.js`
- Create: `apps/web/e2e/timesheet-review-workflow.spec.ts`

**Interfaces:**
- Consumes: `get_timesheet_shift_rows`, `review_timesheet`, `correct_timesheet_shift_hours`, `reopen_approved_timesheet`, and the staff reply/history reader from Task 3.
- Produces: one coherent timesheet review path showing source work, payable evidence, place, receiving organization/agreement, replies, decision history, and authorized next actions.

- [ ] **Step 1: Write failing UI/RPC contract tests** named `shift rows show authoritative place and agreement recipient`, `final approval rejects the branch reviewer`, `rejected history survives correction and approval`, and `failed review shows no success notice`. Assert stale correction requests fail. Have `timesheet-shift-attribution-migration.test.js` conditionally require its PostgreSQL test when `BOB_TEST_POSTGRES === '1'`.
- [ ] **Step 2: Run `node --test test/timesheet-final-approval.test.js test/timesheet-shift-attribution-migration.test.js`** and verify the missing per-shift provenance and review-history states.
- [ ] **Step 3: Create the migration** with `supabase migration new timesheet_shift_attribution` and replace `get_timesheet_shift_rows` to return authoritative place and agreement-recipient labels from the existing shift/agreement links. Retain its organization and branch checks; do not expose wage, cost, or commercial rates to roles that cannot already view them.
- [ ] **Step 4: Update the review queue** to identify generated periods as “Ready for payroll review,” display per-shift source and attribution, and show rejection reasons, append-only staff replies, and prior decisions from `get_timesheet_detail` as separate history.
- [ ] **Step 5: Wire actions only to governed writers.** Use `review_timesheet` for approve/reject and `correct_timesheet_shift_hours` for reasoned shift corrections, including corrections that return a rejected sheet to review. Keep approval human-only and preserve the original attendance. A modal Cancel only dismisses the modal; it must not claim to cancel persisted work.
- [ ] **Step 6: Keep financial measures separate.** Label existing wage and client-charge data independently and with their current role visibility. Do not add a loaded-cost estimate, cost posting, or invoice action in this slice.
- [ ] **Step 7: Run `node --test test/timesheet-final-approval.test.js test/timesheet-shift-attribution-migration.test.js` and `$env:E2E_OFFLINE='1'; npx playwright test e2e/timesheet-review-workflow.spec.ts; Remove-Item Env:E2E_OFFLINE` from `apps/web`** for loading, empty, partial, permission, error, stale, success, and recovery states; verify screen-reader labels and mobile-width overflow.
- [ ] **Step 8: Commit** the page, migration, and tests as a reviewable change.

### Task 5: Verify the Vertical Slice Before Release

**Files:**
- Verify: all files changed by Tasks 1-4
- Refresh only after a real schema/code change: `supabase/schema.sql` and Atlas-owned tables through the governed scripts

**Interfaces:**
- Consumes: completed tasks 1-4.
- Produces: test evidence, a role-specific human walkthrough, refreshed schema/Atlas evidence, and a release decision. A green local test is not evidence of live payroll execution.

- [ ] **Step 1: Run `node --test test/timesheet-pay-period-migration.test.js test/timesheet-period-generation-migration.test.js test/timesheet-staff-reply-migration.test.js test/timesheet-final-approval.test.js test/timesheet-shift-attribution-migration.test.js`** for the focused Node contracts.
- [ ] **Step 2: Run `$env:BOB_TEST_POSTGRES='1'; node --test test/timesheet-pay-period-migration.test.js test/timesheet-period-generation-migration.test.js test/timesheet-staff-reply-migration.test.js test/timesheet-shift-attribution-migration.test.js; Remove-Item Env:BOB_TEST_POSTGRES`** for disposable-PostgreSQL coverage.
- [ ] **Step 3: Run `npm run build`; then run `$env:E2E_OFFLINE='1'; npx playwright test e2e/officer-timesheet.spec.ts e2e/timesheet-pay-period-settings.spec.ts e2e/timesheet-review-workflow.spec.ts; Remove-Item Env:E2E_OFFLINE` from `apps/web`.**
- [ ] **Step 4: Run the mobile human walkthrough** for loading, empty, generated, rejected/reply, permission, offline/error, and retry states; record only redacted results.
- [ ] **Step 5: Verify Before/During/After** with dedicated staff and payroll test identities: configured employer and period; visible source, requests, errors, audit/notification receipts; then persisted timesheet, history, next reviewer action, and no duplicate work lines.
- [ ] **Step 6: Run the canon-conformance and UX-states reviews.** Treat any conflict with the place, staff, work, evidence, access, or human-control rules as a blocker.
- [ ] **Step 7: After approved migration application, regenerate `supabase/schema.sql`, refresh Atlas with `node scripts/atlas-refresh.js --apply`, and verify real `reads`/`writes`/`secured_by` edges. Keep `flow_reach` and `fk_reach` separate; do not claim “exercised” without invocation evidence.
- [ ] **Step 8: Release through a pull request only.** Confirm required checks and a human walkthrough before merge; do not push directly to `main` or bypass deployment protections.

---

## Self-Review

- **Spec coverage:** The Workforce slice covers background preparation, employer cycle setup, human correction/approval, staff responses, provenance, role visibility, recovery, and explicit failure states. Client Data & Setup and broader Finance remain separate plans as required. Loaded-cost posting and billing are explicitly deferred rather than simulated.
- **Step scan:** Each task starts with a failing contract test, implements one bounded capability, verifies it, and ends with a reviewable commit. Schema snapshot and Atlas refresh happen only after governed live changes.
- **Type consistency:** The pay-cycle settings RPC, generated period writer, reply RPC, review-history reader, and existing review/correction RPCs are named consistently across tasks. No new timesheet status is introduced; generated rows use the existing `submitted` state with explicit background provenance and user-facing “Ready for payroll review” copy.
- **Review Focus:** All five failure classes map to explicit tests in their owning tasks.
- **Proportion:** This plan implements only the approved Workforce/timesheet slice. It does not attempt the full three-area redesign or the earlier narrower draft's loaded-cost allocation.
