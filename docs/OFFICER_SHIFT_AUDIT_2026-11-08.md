# Officer shift audit, 2026-11-08

## Scope and evidence boundaries

Requested workflow: an assigned officer onsite at a contracted static post,
unable to start the original 18:00 overnight shift because of an app error.
The officer must start that same rostered assignment later, not the next
evening's assignment and not an unscheduled replacement.

Live checks used server-side service-role and Management API read-only
diagnostics, scoped to the supplied identity and recent shift window. No user
password, session or impersonation was used. Private narrative, patient data,
coordinates and credential values were excluded from diagnostic output.

Browser checks used the existing synthetic officer fixtures on desktop and
phone. They are not a live-device or production-business-write certification.
The working branch starts at `ea4deca15`; fetched main/Atlas source is
`65371fc20`. Several production officer changes are absent from this branch.

## Resolved live blocker: private Oracle route

- Before: the human's Start shift action reported that private Oracle review
  was unavailable. The current shift remained accepted, with no actual start,
  arrival, attendance action or debrief receipt.
- During: current main's `officer-shift-briefing` handler sends narrative to
  `/api/bob/officer/privacy`. Inside the control-plane container, synthetic
  review returned HTTP 200, `privacy.status=checked`, provider
  `gpu_workstation`. The public route returned HTTP 404. Nginx's explicit
  route allowlist omitted this endpoint; its default location returns 404.
  Public health and the private model were healthy. Required edge configuration
  names were present; no values were exposed.
- After: the owner explicitly approved adding this exact nginx route and
  reloading nginx, with no shift/database writes. The deployed config matched
  the repository baseline before modification. A backup was retained under
  `/var/backups/`; `nginx -t` succeeded before reload. Public verification now
  returns 401 without authentication and 200 with a checked private receipt
  using synthetic input. Health remains 200. No privacy fallback or hosted-model
  escalation was added. The actual officer's subsequent click is still needed
  to prove full production briefing delivery and attendance.

Owning paths:

- [Nginx config](../deploy/bob-vps/nginx/bob.fcmanager.co.nz)
- [Routing regression](../test/bob-vps-access.test.js)
- Current-main-only endpoint: `supabase/functions/officer-shift-briefing/handler.ts`
- Current-main-only private reviewer: `officer-privacy-oracle.js`

## Local correction: overnight roster selection

- Before: the latest live breadcrumb was linked to the next evening's 18:00
  accepted shift while the current overnight shift was still accepted. The
  shared hook selected the newest scheduled start among shifts overlapping the
  browser's calendar day. Both overnight and next-evening assignments can match
  after midnight. Separately, old unfinished in-progress shifts could disappear
  because of the date filter.
- During: the local hook now prioritises an in-progress shift, then an accepted
  shift covering now, then the nearest upcoming assignment. In-progress shifts
  are not excluded solely because their scheduled day has passed. Existing
  officer filtering and RLS remain; rostered timestamps are not changed.
- After: four hook regressions pass; 19 focused hook/consumer checks and the web
  TypeScript gate pass. A phone browser in `Pacific/Auckland` clicked Start shift
  at 00:30 against the original 18:00 overnight ID and received a matching
  synthetic start receipt. Its following GPS-delivery assertion did not pass:
  initial capture had no shift context and subsequent capture was not observed
  in that harness. Do not claim browser proof of corrected GPS delivery.
  This hook correction is local only, not committed, merged or deployed.

Owning paths:

- [Active shift hook](../apps/web/src/hooks/useActiveShift.ts)
- [Hook regressions](../apps/web/src/hooks/useActiveShift.test.tsx)
- [Exact-ID start action](../apps/web/src/pages/OfficerSchedulePage.tsx)
- [GPS capture and throttling](../apps/web/src/shells/OfficerShell.tsx)

## Before, during and after the officer workflow

Before: the active identity is an admin officer. The current assignment has a
roster link, agreement-place link, enabled static module and one required static
task. Its site is active and has valid verified boundary geometry. The sampled
latest fix lies inside that boundary, but is not linked to the current shift.
GPS geometry by itself is not a start/arrival receipt. An earlier shift has a
manual correction audit, actual times, `ended_reason=not_started` and a missed
stop; it is not proof of recorded physical attendance.

During: Start shift loads safety first. Successful static start then calls
`start_officer_static_shift`, which combines start and arrival transactionally.
Unverified attendance requires an explanation and review evidence. Breaks use
actual start/end receipts. Reports use an idempotent submission ID and validate
the returned shift ID; a single-place report can inherit its assigned place in
the database. One recent live H&S report has both shift and site links and is
still submitted; its private contents were not inspected.

After: debrief and completion have separate checked receipts. Static completion
combines departure and completion; open breaks, dispatch, welfare and other
required work remain server-checked. The current live shift had zero open
dispatch jobs and welfare alerts, and no debrief. Completed shift actual time
and actual unpaid breaks feed the timesheet work projection; completion does
not automatically prove payroll approval, invoicing or client publication.

## Atlas and schema

Capability, direct terrain, secured-by, upstream flow and structural FK queries
were performed. Relevant start/end, report and breadcrumb RPCs were mapped as
present/wired; RPC exercised flags were unset. Some table exercised flags are
now true, contradicting older documentation's zero-population claim; these
flags were not treated as proof of this officer's invocation.

Atlas maps `hooks/useActiveShift -> shifts` as a read. Report and breadcrumb
callers and SQL writers were cross-checked in source. For `shift_stops`, depth-2
upstream flow returned 131 entries and depth-1 FK reach returned 14 entries;
these are distinct graph results, not 145 proven downstream workflows. Security
edges identify inspection targets, not proof that every policy denies correctly.

Relevant live function code/grants and the migration ledger were inspected.
Two attendance helper bodies differ behaviorally from this branch's snapshot:
live static-end readiness permits a pending post to be closed at departure and
records that exception. The raw briefing/private-disclosure boundary remains a
separate canon audit; this routing repair does not certify it.

## Browser and visual evidence

Direct synthetic desktop/phone interaction passed start, required GPS exception,
break start/end, refusal to finish during an open break, required report fields,
follow-up validation, matching report receipt, debrief and static completion.
Fifteen screenshots were generated; accepted-post, exception, report-entry,
debrief and completed states were visually inspected. No horizontal overflow was
observed in these walkthroughs. Screenshots/results remain under `/tmp/fcm-officer-*`.

The static post uses a light page while schedule/report use dark pages: whether
that is intentional remains a design question, not a confirmed defect. The
fixture logo failed to load with external assets blocked; this is not evidence
of a production logo defect. Phone keyboard, real camera, installation,
background location and browser suspension were not proven.

Initial focused web checks: 85 passed. Initial workflow browser suite: 64 passed,
8 failed. The GPS-address fixture returns an unlinked receipt despite a selected
shift; the form correctly rejects it. Other failures include screenshot
comparisons. Supporting safety/dispatch/timesheet/map browser checks: 24 passed,
12 failed. This is not a green full-browser-suite claim. Three focused VPS
routing/credential contract tests pass, and `git diff --check` passes.

## Remaining actions

1. Human retry of Start shift on the original overnight assignment; verify
   briefing, start and arrival receipts and current shift status.
2. Integrate the local hook fix through the normal PR/release lane, then refresh
   Atlas through the governed generator. No application commit/deploy or live
   Atlas write was performed in this audit.
3. Verify fresh GPS receipts carry the original shift ID on a real phone,
   including after midnight, screen lock and network interruption. Multi-hour
   live GPS gaps were observed; their cause is not established.
4. Any correction for work done before the successful app start must preserve
   rostered versus actual versus administrator-recovered time and use the
   existing reasoned/audited correction path. Never silently backdate presence.
5. Retain the original private-briefing access review, fixture failures and
   pending human acceptance as open evidence gaps. No repository issue was
   published and no business record was created or changed.