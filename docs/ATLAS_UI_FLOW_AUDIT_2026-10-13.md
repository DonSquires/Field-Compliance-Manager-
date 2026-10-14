# Atlas-to-UI flow audit — 2026-10-13

## Scope and evidence

This audit tests the sample Atlas gaps against the current routes, components,
callers, and canonical schema. It does not treat `wired = false` as proof of a
broken screen. The local Atlas manifest contained 331 live capabilities with no
detected inbound edge: 19 edge functions, 242 RPCs, and 70 tables.
After correcting the missed declarative SQL caller, wiring Bob completion
notifications, registering proven external caller contracts, wiring the
bounded platform diagnostic family, closing the finance callers, calibrating
the test-only synthetic seed, retiring four obsolete edge functions, and
correcting trigger, RLS, schema-scope, cron-contract, and historical-migration
false negatives and integrating current `main`, the release dry run reports
1,376 capabilities, 7,306 edges, and 190 capabilities with no detected inbound
edge: 1 edge function, 133 RPCs, and 56 tables. The latest pre-release live
refresh records 212 gaps. The release source includes the finance budget
lifecycle, post-approval variance and cost-centre calculations, payment
receipt, and investigation timeline commands, together with other current-main
terrain additions. Neither inventory claims runtime exercise for newly wired
capabilities; live counts must be refreshed from the clean pushed commit after
deployment.

Evidence used:

- `scripts/atlas-refresh.js` dry-run manifest
- `apps/web/src/shells/AdminShell.tsx`
- `apps/web/src/components/NotificationCenter.tsx`
- `apps/web/src/lib/notificationNavigation.ts`
- `apps/web/src/pages/ApprovalsActivityPage.tsx`
- `apps/web/src/pages/BuilderControlRoomPage.tsx`
- the sampled edge functions and their repository callers
- `supabase/schema.sql`
- `supabase/schemas/ops/functions/enqueue_bob_gitea_sync.sql`
- live Atlas refresh receipt and aggregate service-role verification

The live refresh proves map persistence, not runtime exercise of every
capability. `exercised` remains reserved for invocation evidence.

Bob's `query_atlas` tool now has a `status` action and includes Atlas refresh
metadata with other query results. It reports live row counts and the latest
capability/edge refresh timestamps, but labels source-commit parity `unknown`
because the Atlas tables do not record the generating commit. Bob must compare
that evidence with `repo_search` or `assess_system` before calling Atlas current.

Live acceptance finding 2026-10-13: a signed-in `master` session could open Bob
but Bob's Atlas request was rejected as `admiral only`. The root cause was a
second admiral-only execution and advertisement gate in the Conductor, after
the Caddie and Atlas function had already been aligned with `CAN_SQL`. Those
gates are now corrected and deployed. The same master session successfully
returned the latest Atlas refresh timestamp; source parity remained
`unverified` because the request did not provide an expected commit. A later
explicit gap-report request was interrupted by the browser session signing
out, so no gap is called exercised from that attempt.

## Sample classification

| Capability | Present path | Proven caller or destination | Classification | UX conclusion | Priority |
|---|---|---|---|---|---|
| `bob-chat-bell-notify` | Service-only edge function writes `notifications` through `enqueue_notification` | `onspace-ai-chat` now invokes it after a durable Bob turn completes | Wired completion path | Completion notices are personal, tenant-scoped, deduplicated by conversation/request, navigate to the exact Bob conversation, and persist delivery status in the turn receipt. Legacy Bob/Duo notepad notices remain supported. | Fixed |
| `bob-email-view` | Verified owner/Bob diagnostic edge function | `onspace-ai-chat` `inspect_platform_services` read action | Wired, not exercised | Bob can inspect bounded provider health, domains, delivery counts, inbound state, and redacted logs without an end-user email screen. | Fixed locally |
| `desktop-client-config` | Public bootstrap edge function returns URL and anon key | Registered `fcm-desktop-client` external contract | External-client contract, not exercised | A browser page is not implied. Atlas now records the external caller without falsely claiming runtime exercise. | Calibrated |
| `bob-gitea-maintainer` | Verified owner/Bob, allowlisted repository integration | `onspace-ai-chat` exposes GET-only repository diagnostics | Read path wired, not exercised | Bob can inspect the allowlisted repository. Gitea writes remain a separate Bob-identity path and are not exposed through the diagnostic tool. | Fixed locally |
| `bob-gitea-sync` | Secret-protected edge function | `ops.enqueue_bob_gitea_sync` invokes it and cron schedules that RPC | Atlas false negative | This is wired infrastructure, not a UI gap. The Atlas generator omitted declarative `supabase/schemas` SQL; the generator now scans it. | Fixed |
| `bob-ptt-view` | Verified owner/Bob PTT relay diagnostic | `onspace-ai-chat` `inspect_platform_services` read action | Wired, not exercised | Bob can inspect bounded connection, room, TURN, and redacted recent-error state. Officer PTT remains on its separate client path. | Fixed locally |
| `bob-vercel-view` | Verified owner/Bob Vercel diagnostic | `onspace-ai-chat` `inspect_platform_services` read action | Wired, not exercised | Bob can inspect bounded projects, deployments, failures, domains, and environment-variable names; no values or deployment write authority are exposed. | Fixed locally |
| `bob-propose-place-org-from-parcel` | Legacy producer created an organisation to represent a parcel | Superseded by canonical place registry plus organisation-owned `locations` links through `_shared/houseResolve.ts` | Retired model contradiction | Removed rather than wiring a caller that would fork place identity into an organisation record contrary to the 2026-09-15 house-model ruling. | Closed |
| `capture-environmental-evidence` | Direct assessment/evidence primitive | Web and mobile call the governed `submit-biosecurity-assessment` and `submit-smoke-assessment` commands instead | Retired duplicated primitive | Removed after confirming both governed commands own watermarking, evidence storage, classification, receipt, and audit paths. | Closed |
| `delete-user` | Legacy grand-master hard-delete endpoint | User management intentionally exposes audited `deactivate-user`, not hard deletion | Retired unsafe destructive path | Removed because it deleted profile rows before Auth deletion, had no durable audit receipt, and did not guarantee session/token revocation. | Closed |
| `bob-reverse-job-step` | Admin/master/grand-master reversal endpoint for `bob_job_runner` writes | No UI or Conductor caller; references are written by `bob-job-runner` and keyed to `bob_job_runs`, not `builder_jobs` | Confirmed Bob-job recovery-flow gap | Do not attach this table to Builder Control Room. If governed reversal remains supported, expose it from the Bob job-run/review path with target, impact, scope, confirmation, result receipt, and manual-only outcomes. | P1 |
| `bob-self-memory-approve` | Owner-only approval endpoint | No UI caller | Retired contract contradicted live schema doctrine | Removed because `bob_self_memory` explicitly records owner delete as the sole human action and retires the approval apparatus. | Closed |

## Confirmed user-facing findings

### 0. Bob agentic and Builder lanes were merged at the decision boundary

**Before**

- Expected: Atlas scans, technical questions, diagnosis, reviews, and
  recommendations remain in Bob's agentic/read lane. Builder becomes eligible
  only after an explicit implementation request.
- Present: a read-only Atlas triage request that explicitly said to exclude
  Builder was converted into a `create_builder_job` proposal.

**During**

- Expected: selecting **No, cancel** on a pending Builder proposal consumes the
  proposal without creating any job.
- Present: the exact negative answer created Builder job
  `09af1826-5e6e-4709-a38e-c7656976c48f`.
- Remediation evidence: the unintended job was cancelled through the governed
  control-room action. The Conductor now has a deterministic negative-answer
  guard and requires a bounded affirmative before a stored proposal can create
  a job. The planner prompt states that diagnosis and recommendations are not
  Builder authorization.

**After**

- Expected: negative and ambiguous replies leave no Builder job; explicit
  implementation requests still receive the existing two-turn proposal and
  confirmation flow.
- Present locally: focused regressions cover `No, cancel`, `cancel`, `change the
  brief`, and an explicit affirmative. Live verification is still required
  after deployment.

### 1. Notifications: completion producer is now wired

**Before**

- Expected: a durable Bob turn completion produces one deduplicated,
  recipient-specific notification without placing sensitive answer content in
  the bell.
- Present: `onspace-ai-chat` invokes `bob-chat-bell-notify` only for completed
  turns, using the tenant, recipient, conversation, and request identifiers.

**During**

- Expected: the activity centre shows loading, error, empty, unread, and
  critical states.
- Present: `NotificationCenter` implements those states, realtime reload, and
  mark-read feedback. The producer records a success/failure delivery receipt
  in the durable Bob turn response.

**After**

- Expected: selecting the notification opens Bob and marks the row read.
- Present: `bob_conversation`/`bob_chat` resolves to Bob with the exact
  conversation ID, and duplicate completion callbacks reuse the same
  notification through the canonical deduplication key.

### 2. Bob job recovery: endpoint exists, review flow does not

**Before**

- Expected: an authorised administrator can inspect a rollback reference and
  understand the affected record and available reversal method.
- Present: `bob-reverse-job-step` can resolve a reference by ID or job/step.
- Present: `bob-job-runner` writes `bob_job_rollback_refs` for its own
  `bob_job_runs`.
- Missing: the Bob job-run/review path does not load or display those
  references.
- Contradictory: `bob_job_rollback_refs.job_id` has no foreign key or
  organisation column, so the intended job ownership and tenant scope are not
  structurally provable from the table alone.

**During**

- Expected: consequential reversal requires an explicit review and
  confirmation, and hard delete is visibly restricted to grand master.
- Present: the endpoint enforces role checks and defaults to soft reversal.
- Missing: there is no user-facing confirmation, impact summary, manual-only
  guidance, or organisation-scoped job ownership check before invocation.

**After**

- Expected: the administrator receives a durable receipt and the job view shows
  the reversal state.
- Present: the endpoint returns method, target, actor role, and a preserved
  history note.
- Missing: no screen consumes or displays that receipt.

### 3. Major workspaces: standardisation is uneven, not absent

- CRM has client-portfolio search with a visible result count and clear action
  feedback.
- Reports has agreement and date filters, governed report review, PDF, and
  delivery states.
- Notifications has consistent filters and explicit loading/error/empty states.
- Roster/HR is the largest interaction surface but only has a specialised pay
  review filter; most staff, credential, leave, case, asset, on-call, and court
  lists have no shared search/filter model.
- The admin header labels its shortcut accurately as vehicle search; there is
  no deceptive claim of universal search in the active shell.
- `components/stubs.tsx` still contains obsolete placeholder components and
  comments. It is not imported by the active app and should not be used as
  evidence that the current notification or search UI is a stub.

### 4. Finance workflows had status controls without the persisted evidence path

- The budget workspace now covers draft creation, line upsert, approval, and
  replay-safe post-approval variance calculation for a selected P&L period.
  Existing variance rows are updated by the canonical RPC rather than
  duplicated.
- The CRM invoice workspace now records the amount, date, method, and optional
  transaction reference through `record_payment_receipt`. The RPC validates
  the remaining balance, supports partial payments, settles a fully paid
  invoice, and writes an audit event. The UI no longer uses the generic
  lifecycle command to claim that an invoice was paid without a receipt.
- `calculate_cost_centre_roll` now has a unique business key across
  organisation, P&L period, and cost centre, and atomically upserts recalculated
  totals. The approved-budget action runs both variance and cost-centre
  calculations, preserves the successful variance receipt if the second stage
  fails, and reports both persisted result counts.

## Prioritised repair order

1. **Correct Atlas evidence before counting UX defects.** Keep declarative SQL
   callers in the generated terrain map; register explicit external callers
   as `declared-external-contract` edges; separately classify intentional
   internal, retired, and genuinely missing callers. External registration is
   wiring evidence, not runtime exercise evidence.
2. **Resolve the Bob-job rollback ownership model before adding UI.** Bind
   rollback references to a provable Bob job and organisation scope, then add
   review, explicit confirmation, honest manual-only states, and a persisted
   receipt in the Bob job-run/review path. Do not join these rows to Builder
   jobs merely because both use a `job_id`.
3. **Exercise cost-centre roll calculation with live finance data.** Confirm
   repeated execution preserves one row per organisation, P&L period, and cost
   centre and refreshes the persisted totals.
4. **Deploy and exercise the new web callers.** Source wiring is proven, but
   runtime exercise requires the production deployment and live R&M receipts.
5. **Standardise high-volume Roster/HR lists first.** Use one shared query,
   filter, result-count, empty/error, and saved-view contract rather than adding
   page-specific controls.
6. **Treat customisation as governed saved views, not arbitrary layout.** Start
   with role- and tenant-scoped saved filters for Roster/HR and operational
   queues; preserve fixed audit and safety fields.

## Smallest next checks

- Invoke `calculate_cost_centre_roll` twice for the same live R&M period and
  confirm the second run updates the same persisted business-key rows.
- Deploy the validated web build when an authorised Vercel credential and
  project mapping are available, then refresh live Atlas without inferring
  exercise from source.
- Query recent `bob_job_runs` and `bob_job_rollback_refs` read-only, prove their
  job and organisation relationship, and inspect supported statuses before
  designing the recovery path; if there are no supported records, retire the
  endpoint instead.

## Closure log — 2026-10-14

Bounded gap count moved 185 -> 178. Every entry below was deployed to `main`,
verified in the production bundle, and re-registered in live Atlas from the
exact pushed commit. None of them is claimed as `exercised`: Atlas records
runtime exercise only from invocation telemetry, and `bob_capability_map.exercised`
remains unpopulated.

### Closed as genuine missing wiring

- **Patrol session lifecycle** (`start_patrol_session`,
  `record_patrol_checkpoint_visit`, `complete_patrol_session`) — commit `b06798c8`.
  `PatrolPage.tsx` was not merely unwired, it was a second and wrong authority:
  route checkpoints were written into `checkpoint_id` instead of
  `route_checkpoint_id`, so a route patrol could never satisfy the mandatory
  checkpoint rule; starting a patrol was a raw insert with no idempotency;
  proximity and accuracy were adjudicated client-side with a manual fallback
  that accepted a visit with no GPS at all; and completion was a raw update that
  skipped the mandatory checkpoint check and wrote no audit row. The page now
  routes all three steps through the governed RPCs, and the superseded
  client-side adjudication in `lib/checkpointVisit.ts` was retired.
- **Shift asset custody** (`assign_shift_asset`, `return_shift_asset`) — commit
  `1290318a`. A genuinely missing surface rather than a stale one: the RPCs had a
  schema guard test and no UI at all. Officers can now sign out available
  vehicles and equipment against the active shift and file a return condition
  report; the receipt states whether the asset went back to the available pool or
  to maintenance.

### Closed as superseded, by retirement rather than wiring

- `submit_officer_timesheet` -> `submit_officer_timesheet_from_work`
- `submit_noise_assessment` -> `submit_officer_noise_assessment_v2`
- `submit_smoke_assessment` -> `submit_smoke_assessment_receipt_v2`

  Migration `20261014120000_retire_superseded_submission_rpcs.sql`. All three
  were dead `SECURITY DEFINER` functions still granted to `authenticated`, so
  each remained a second unaudited writer for a table that already had a
  governed authority. `submit_officer_timesheet` was the sharpest: it accepted
  typed `p_actual_hours` up to 744 and inserted a `submitted` timesheet with no
  `timesheet_work_entries` provenance, which is exactly the self-reporting the
  successor exists to prevent. Verified before drop: no application caller, no
  Edge Function caller, no other database function referencing the names.
  Guarded by `apps/web/src/lib/retiredSubmissionRpcs.guard.test.ts`.

### Corrected Atlas under-reporting

- The generator read SQL function bodies only from `supabase/schemas/**` and
  `supabase/schema.sql`. The live snapshot dumps the public schema only, so
  `ops`-schema scheduler functions existed nowhere but their migrations and
  their `net.http_post` calls to Edge Functions were invisible to blast radius.
  `collectSqlFunctionEdges` now also reads `supabase/migrations/**`, but only
  keeps `ops`-qualified definitions — an unqualified sweep would resurrect
  public functions that have since been dropped, and `schema.sql` must stay the
  authority for anything it does contain. Three real edges appeared:
  `enqueue_welfare_escalation_tick -> welfare-escalation-tick`,
  `enqueue_credential_expiry_notifications -> notify-credential-expiry`, and
  `enqueue_canonical_ta_refresh -> bob-refresh-canonical-ta-names`. This also
  fixes the long-failing `atlas-calibration` test "Atlas refresh derives Ops
  scheduler HTTP calls to edge functions".

### Stale references cleaned up

- `edgeFunctionAudit.test.ts` still read the retired
  `capture-environmental-evidence` function source, which failed the whole web
  suite at collection time. Removed, along with the stale mentions in
  `docs/design/BIOSECURITY_GOVERNED_MODULE.md` and the
  `check-house-conflict-any-org` header comment.

### Known remaining debt

- `src/types/database.ts` is stale: it is missing both
  `submit_officer_noise_assessment_v2` and `submit_smoke_assessment_receipt_v2`,
  and a current `supabase gen types` run differs from it by roughly 7,500 lines.
  The retired entries were removed surgically rather than regenerating, because
  a wholesale replacement would be an unreviewable diff in the same change as a
  live function drop. Regenerating it deserves its own change.

### Closure log — officer unscheduled shift

- `start_ad_hoc_officer_shift` now has a real caller in
  `OfficerSchedulePage.tsx`. Officers can choose an active organisation work
  unit, record who asked them to begin and why, and start an unscheduled shift
  through the governed RPC. The page only shows this action when no shift is
  already in progress, and completion continues through the existing
  debrief/readiness/`complete_officer_shift` path rather than creating a
  second stop authority.
- Atlas moved 178 -> 177 bounded gaps. The capability is `wired=true`; it is
  live and has direct invocation evidence. The dedicated `admin_officer` test
  identity completed start -> debrief -> governed completion; the persisted
  shift has `shift_origin=ad_hoc`, `status=completed`, an end timestamp, and
  `officer_ad_hoc_shift_started` plus `officer_shift_completed` audit actions.
  `bob_capability_map.exercised` remains empty because the current exercise
  evidence pipeline maps audited table writes but does not yet map RPC names;
  this report records the invocation without falsifying that Atlas field.

### Closure log — court appearance lifecycle

- `schedule_court_appearance` and `record_court_appearance_outcome` now have
  real callers in the existing Roster HR Court tab. The tab previously read
  `court_appearances` but could neither create nor close one.
- Roster administrators can schedule a hearing, trial, deposition, tribunal,
  mediation or other appearance; the server determines whether it falls
  outside a rostered slot, records overtime, notifies the officer, deduplicates
  retries and audits the receipt. Scheduled appearances expose a governed
  outcome action with expected-state concurrency. Attended outcomes require
  actual start/end times; adjourned, cancelled and excused outcomes remain
  explicit rather than being hidden as deletion.
- Atlas moved 177 -> 175 bounded gaps. Both capabilities are `wired=true`.
- The deployed workflow was exercised across both roles: the `grand_master`
  test identity scheduled an explicitly labelled non-real appearance for the
  dedicated `admin_officer` identity, and that officer recorded it as
  `cancelled`. The persisted row is cancelled with reference `ATLAS-VERIFY`;
  audit actions are `court_appearance_scheduled` and
  `court_appearance_outcome_recorded`. This also confirms the intended
  separation: `admin_officer` cannot schedule because scheduling requires an
  active roster administrator, but can record the outcome of an appearance
  assigned to them.
