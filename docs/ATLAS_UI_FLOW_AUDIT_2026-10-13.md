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

### Closure log — superseded direct SLA arrival

- `record_sla_arrival` was not a missing screen or action. It was an uncalled
  second authority that accepted an SLA clock ID and timestamp directly,
  carried no shift, dispatch, GPS, geofence or officer-command receipt, and
  remained executable through `PUBLIC` and `anon`.
- Before arrival, `dispatch_job_create_sla_clock` creates the running clock
  from the dispatch job and its SLA target. During arrival,
  `arrive_at_dispatch_place` records the officer's in-progress shift,
  idempotent command, place attendance and GPS/geofence result; the standard
  dispatcher transition can also stamp the job's `on_scene_at`. After either
  governed path, `trg_dispatch_job_close_sla_clock` computes elapsed minutes
  and the met/breached verdict from that persisted job state.
- Migration `20261014130000_retire_superseded_sla_arrival.sql` dropped the
  detached writer. The live schema snapshot proves the function and its broad
  grants are gone while both arrival authorities, SLA-clock creation and the
  closing trigger remain.
- Atlas dry-run moved 175 -> 174 bounded gaps: 1 edge function, 118 RPCs and
  55 tables. This is a retirement closure, not a claim that a new user action
  was exercised.

### Closure log — dispatch response timing

- `manage_dispatch_job_timing` existed as a governed, audited RPC but had no
  caller. Dispatchers could see a job's response target, respond-by timestamp,
  expected attendance and timing source, but could not correct any of them
  when the operational plan changed.
- The existing job-detail dialog now owns the missing action. Before the
  change, it loads the current values and locks completed or cancelled jobs.
  During the change, it constrains response targets to 1-1,440 minutes and
  expected attendance to 1-240 minutes, records an allowed timing source, and
  requires a human reason. The RPC uses the displayed status as an optimistic
  concurrency check.
- After success, the dialog reloads server state, the new absolute
  `sla_respond_by` and attendance expectation are visible to dispatch, and the
  operator receives confirmation that an audit receipt was written. Server
  failures remain visible in the dialog rather than being presented as a
  successful update.
- Atlas dry-run moved 174 -> 173 bounded gaps: 1 edge function, 117 RPCs and
  55 tables. The capability is now `wired=true`; runtime exercise remains
  unclaimed until a governed live job can be changed without fabricating an
  operational event.

### Closure log — direct officer dispatch handoff

- `queue_dispatch_job_for_officer` was the server authority for urgent,
  roster-independent handoff, and the officer queue already read jobs assigned
  through `assigned_officer_id`, but the dispatch console had no caller. An
  administrator therefore could not originate the handoff that the officer
  experience was designed to receive.
- The new-job workflow now loads manageable active officers and active roster
  work units in the operating branch. Before submission, the dispatcher must
  choose both the officer and the authorizing work unit; direct handoff is
  deliberately limited to an agreement-linked Site because the RPC does not
  accept a Zone or provisional incident location.
- During submission, the work unit's schema-backed `service_type` becomes the
  job module key, the existing client request ID protects retries, and the RPC
  verifies administrator, agreement, officer and work-unit authority. Resource
  assignment is mutually exclusive with direct officer handoff.
- After success, the job appears in the named officer's dispatch queue. The UI
  states the remaining safety boundary explicitly: the officer must start or
  already hold an in-progress shift before the governed attendance action can
  create a stop and record GPS/geofence evidence.
- Atlas dry-run moved 173 -> 172 bounded gaps: 1 edge function, 116 RPCs and
  55 tables. Runtime exercise remains unclaimed because creating a live
  dispatch job without a real operational event would be false evidence.
- Production verification in the authenticated R&M console confirmed the
  deployed direct-officer picker, the active work-unit picker (three current
  choices), the shift/attendance boundary copy, and the disabled Create state
  before a Site and work unit are selected. The form was cancelled without
  creating or altering a dispatch job. The same deployed chunk contains the
  response-timing RPC and controls; there was no active job on which a timing
  change could be truthfully exercised.

### Closure log — shared operational continuity

- The schema already held the provider/client continuity contract, immutable
  handoff projection and receipt model, but none of its three governed RPCs
  had an application caller. Policy setup, safe publication and recipient
  acknowledgement therefore existed as detached database capabilities rather
  than a task a person could complete.
- Before exposing that path, the acknowledgement authority was hardened. A
  first acknowledgement now requires an active, unexpired handoff. An optional
  continuation event must belong to the recipient organisation, use the same
  module, match the exact Site or Zone, and occur after the source event.
  Idempotent retries still return their original immutable receipt. Execute
  access is explicitly revoked from `PUBLIC` and `anon`.
- Agreement operational setup now owns continuity policy configuration. The
  administrator selects an accepted agreement location and enabled module,
  then configures mode, provider/client NZ-time coverage, retention, case/task
  sharing, attachment/presence disclosure and acknowledgement requirements.
  Complete coverage windows and bounded hour values are validated before the
  policy RPC is called; the page never writes the policy table directly.
- Field Operations now contains a shared Operational continuity workspace.
  During publication, an operator chooses a real recent location event,
  supplies the safe summary and disclosure flags, and submits through
  `publish_location_event_continuity` with a request ID retained across
  retries. The UI states that the source record remains owned by its authoring
  organisation.
- Recipients see only active, unexpired handoffs and any immutable receipt.
  Acknowledgement can include notes and an eligible continuation event. The UI
  filters that optional link by recipient, module, exact Site/Zone and time;
  the hardened RPC repeats those checks as the security boundary. After
  success the queue reloads server state, while outgoing publications remain
  visible to their authoring organisation.
- Focused guards passed (19 assertions across four files), the production web
  build passed, and the regenerated live schema proves the hardening body and
  grants. Atlas dry-run moved 172 -> 169 bounded gaps: 1 edge function, 113
  RPCs and 55 tables. All three RPCs are now `wired=true`; no runtime exercise
  is claimed because no operational record was fabricated for verification.
- Authenticated production verification used the dedicated `admin_officer`
  test identity and the Admin Portal. The deployed workspace rendered its
  projection boundary, receive queue and publish form without an alert. The
  live organisation had zero active incoming handoffs and five source-event
  choices including the placeholder; no policy, handoff or receipt was
  created or changed. Live Atlas was seeded from commit `9c966dc2` and
  confirmed the three RPCs as wired with `exercised` still unclaimed.

### Closure log — governed patrol-log import

- Atlas exposed three unwired RPCs for the patrol import lifecycle:
  `begin_patrol_import_batch`, `stage_patrol_import_chunk` and
  `finalize_patrol_import_batch`. The operational script predated those
  authorities and still used privileged SQL to insert or update observations,
  location events and canonical vehicles directly. That made the script a
  stale second authority rather than evidence that the RPCs were dormant.
- Before the change, an apply could bypass the frozen source identity,
  contracted-place checks, importer ownership checks, immutable provenance
  conflict handling, review batch and consequential-write receipt. Its
  hard-coded actor was also the earlier human identity rather than the
  dedicated non-login import profile established by the live schema.
- The script now computes and verifies the source SHA-256, records source
  file/sheet/row provenance, computes a derivative hash, binds the configured
  import classification profile, and builds a frozen idempotency identity.
  Local dry-run parses and reports candidate/unresolved counts without
  contacting the database or writing any record.
- During apply, the dedicated import identity starts one governed batch,
  stages bounded chunks through the contract-scoped RPC, and records inserted
  versus matched evidence. No direct evidence-table mutation remains in the
  runner. The final receipt explicitly proves zero direct workshop or finance
  writes.
- After successful staging, the final RPC must return `needs_review`; the
  existing File System review surface remains the human checkpoint before any
  consequential row proposal can be promoted. A failed or partial run retains
  the same frozen source/configuration identity for safe retry rather than
  silently starting a different import.
- Script syntax checks, ten focused guards and a generated one-row local
  dry-run passed. The dry-run classified the unresolved test place without a
  database call. Atlas now recognises known RPCs invoked through
  `SELECT`/`PERFORM`/`LATERAL` SQL in source scripts, and its dry-run moved 169
  -> 166 bounded gaps: 1 edge function, 110 RPCs and 55 tables. No live patrol
  file was applied, so runtime exercise remains unclaimed.

### Closure log — finance payment reconciliation

- Atlas exposed `match_finance_bank_statement_line` and
  `match_finance_external_bank_transaction` as present but unwired. The money
  dashboard could show imported bank activity and customer receipts, but a
  finance administrator had no governed task surface for joining the two.
- Before this change, either RPC could rematch a bank movement, reuse one
  receipt across the statement and connected-bank sources, or match excluded
  or disputed state. The original statement RPC also treated debit and credit
  amounts alike. A scoped live aggregate check found no statement lines,
  external transactions, payment receipts or duplicate matches in the current
  R&M organisation, so the authority could be hardened without rewriting
  business records.
- The database now serialises on the receipt identity, locks both source rows,
  retains same-match retries as idempotent, rejects stale states, and prevents
  receipt reuse within or across the two import paths. Partial unique indexes
  backstop each source table. Only incoming credits with an exact amount may
  be matched. Both security-definer RPCs retain authenticated/service-role
  execution while `PUBLIC` and `anon` are explicitly revoked.
- During reconciliation, the new money-page workspace loads only the active
  organisation's unmatched/review credits and pending/unmatched receipts. The
  administrator selects a bank credit, sees only exact-amount candidates and
  confirms through the governed RPC. Loading, permission, empty, error,
  success and concurrent-change retry states are explicit; the browser never
  writes any reconciliation table directly.
- After success, the bank movement and receipt are marked matched in one
  transaction, reconciliation provenance is recorded on the receipt, an audit
  event is emitted, and the workspace reloads persisted server state. Outgoing
  money, disputed receipts and already-consumed records remain outside the
  action.
- Both migrations were applied to the linked project and
  `supabase/schema.sql` was regenerated from the live catalog. Thirteen
  focused finance guards passed across three files, the production web build
  passed, and `git diff --check` was clean. Atlas dry-run moved 166 -> 164
  bounded gaps: 1 edge function, 108 RPCs and 55 tables. The two RPCs are now
  statically wired; runtime exercise remains unclaimed because no finance
  record was fabricated.
- Authenticated production verification used the dedicated `admin_officer`
  session on the deployed money route. The reconciliation region rendered
  without an alert, reported zero eligible incoming bank credits and zero
  receipt candidates, and kept confirmation disabled. This agrees with the
  pre-change live aggregate diagnostic. No transaction, receipt, match or
  audit event was fabricated for verification. Live Atlas was refreshed from
  release commit `8e07e4ed`; both RPCs report `present=true`, `wired=true` and
  `exercised=null`.

### Closure log — approved-timesheet labour cost

- Atlas showed `post_finance_timesheet_labour_cost` as present but unwired.
  The schema could turn an approved timesheet into an actual service cost, but
  finance administrators had no task surface for reviewing the attribution
  and invoking that authority.
- Before exposure, the RPC accepted any same-tenant agreement and any open
  P&L period supplied by its caller. It did not prove that the agreement came
  from the timesheet's shift, that location and module links agreed, that the
  accounting period contained the work dates, or that optional work-unit and
  cost-centre attribution belonged to the same operational path. A scoped
  admin-officer aggregate found one approved/paid timesheet already accounted
  for and no unposted approved shift timesheet to mutate.
- The hardened RPC now serialises by timesheet, locks the approved source,
  requires one governed shift for the same staff member, derives the accepted
  operational agreement from active shift location/module links, and rejects
  conflicting contract links. The selected P&L period must remain open and
  contain the complete work period. Service type, work unit and active
  cost-centre attribution are rechecked server-side; idempotent retries can
  only return a posting with the same accounting attribution.
- The money page now includes an Actual labour costs workspace. It lists
  approved or paid shift timesheets that have not been posted, resolves their
  shift agreement and applicable hourly pay rule, and offers only containing
  draft/locked periods. Missing agreement or rate evidence is shown as a
  blocked state rather than creating a zero-cost line. The browser invokes the
  governed RPC and never inserts service costs or labour postings directly.
- After success, one service-cost line and one unique posting preserve the
  shift, agreement, work unit, hours, rate rule and accounting-period
  snapshot, followed by an audit event and a reload of persisted state.
  Existing deliberate support for unresolved rates remains in the database
  authority for non-UI governed callers, while this human workflow requires a
  resolved rate before confirmation.
- The migration was applied to the linked project and the live schema snapshot
  regenerated. Fifteen focused finance guards passed across three files, the
  production web build passed, and the Atlas dry-run moved 164 -> 163 bounded
  gaps: 1 edge function, 107 RPCs and 55 tables. Runtime exercise remains
  unclaimed because no finance record was fabricated.
- Authenticated production verification used the dedicated `admin_officer`
  session after Vercel deployed release commit `7bf38100`. The Actual labour
  costs region rendered without an alert, reported that no approved shift
  timesheets were waiting, and kept the posting action disabled. No timesheet,
  cost line, posting or audit event was created. Atlas reports
  `post_finance_timesheet_labour_cost` as present and wired; exercise remains
  unclaimed.

### Closure log — draft invoice line review

- Atlas showed `add_crm_invoice_line` and `remove_crm_invoice_line` as present
  but unwired while Accounts receivable offered Send, payment and void actions
  without a line-review task. The operator could not inspect or safely adjust
  a generated draft before delivery.
- Before exposure, add retries could create duplicate charges because
  `client_request_id` was recorded only in audit metadata. Removal could also
  delete a completed-work invoice line while its workshop, dispatch, patrol or
  service-cost source remained stamped with that line ID, permanently
  stranding the source as already invoiced. Quantity, price and description
  bounds were incomplete.
- Invoice lines now carry explicit `generated` or `manual` provenance and an
  optional request identity. A partial unique index makes one manual add
  request map to one line, while audit lookup prevents a removed request from
  silently recreating a different line. Server bounds protect description,
  quantity, price and numeric total. Manual lines snapshot 15% NZ GST fields,
  creator and request provenance.
- Only retry-safe manual lines may be removed. Generated operational-evidence
  lines are immutable in the draft; administrators must correct the source
  work or void the draft rather than sever its audit chain. Removal retries
  return the already-completed receipt, and both authorities recalculate the
  invoice header while holding its row lock.
- Accounts receivable now exposes Review lines for draft invoices. The dialog
  loads persisted lines, distinguishes Operational evidence from Manual
  adjustment, keeps generated rows visibly locked, and requires a confirmation
  before removing a manual row. Add and remove actions use only the governed
  RPCs with stable request IDs; loading, empty, error, success and responsive
  states are explicit.
- A scoped admin-officer aggregate found zero invoices and zero invoice lines
  in the current organisation, so no business record required migration or
  could be truthfully exercised. Both RPCs were safely probed with missing
  invoice identities and rejected the calls without writing. Fourteen focused
  CRM guards passed across three files, the production web build passed, and
  Atlas dry-run moved 163 -> 161 bounded gaps: 1 edge function, 105 RPCs and
  55 tables. Successful runtime exercise remains unclaimed.
- Authenticated production verification used the dedicated `admin_officer`
  session after Vercel deployed release commit `a394b344`. Accounts receivable
  rendered without an alert, showed the truthful no-invoices state, and kept
  Generate from agreement available. No Review lines control was shown because
  no draft invoice exists, and no invoice or line was created for testing.
  Live Atlas reports both line RPCs as wired with exercise unclaimed.

### Closure log — superseded roster-target setup authorities

- Atlas showed `create_cost_centre` and `create_organization_workplace` as
  present but unwired. Schema and source inspection confirmed that both were
  older home-organization-only writers superseded by
  `create_operating_cost_centre` and
  `create_operating_organization_workplace`.
- Before retirement, callers could still discover and invoke duplicate setup
  authorities that did not accept the selected operating organization. The
  active Roster Targets flow already used the branch-aware replacements, which
  enforce both operating authority and organization administration before
  writing the same canonical tables.
- During the change, only the two superseded functions were dropped. Their
  generated type entries and obsolete E2E handlers were removed while the
  operating replacements remained in the page, types, fixtures and live
  schema. `create_roster_work_unit` and `create_roster_slot` were deliberately
  preserved because they still have live database and application callers.
- After retirement, nine focused guards passed, including explicit checks that
  the operating UI path remains and the still-wired roster writers survive.
  The production web build passed. The regenerated live snapshot reports 819
  functions, and Atlas dry-run moved 161 -> 159 bounded gaps: 1 edge function,
  103 RPCs and 55 tables. No user-visible behavior was removed and no runtime
  exercise claim was created by this authority cleanup.
- Authenticated production verification used the dedicated `admin_officer`
  session after release commit `28e61cb0` reached `main`. Work Units & Coverage
  loaded for the selected operating organization without an alert and retained
  New work unit, Add workplace and Add cost centre controls. No workplace, cost
  centre or work unit was created merely to manufacture exercise evidence.

### Closure log — superseded provider-branch activation

- Atlas showed `activate_provider_branch` as present but unwired. The older
  authority activated a provider branch only from `prospect`, but the governed
  Organization settings path now creates branches active immediately through
  retry-safe `create_provider_branch` and never creates that prospect state.
- Before retirement, the database exposed two contradictory branch lifecycle
  authorities even though only one had a reachable before/during/after flow.
  A technical caller could discover the stale transition and bypass the
  current creation receipt and module-inheritance path.
- The stale activation RPC and generated type entry were removed. Historical
  migration evidence remains immutable. Active branch creation still requires
  an authorized administrator, a client request ID, a unique live branch name,
  and inherits the parent provider's enabled modules. Governed archival and
  operating-organization refresh remain unchanged.
- Twelve focused web guards and the historical migration test passed, along
  with the production web build. The regenerated live snapshot reports 818
  functions. Atlas dry-run moved 159 -> 158 bounded gaps: 1 edge function, 102
  RPCs and 55 tables. This is authority cleanup, not successful exercise
  evidence.
- Authenticated production verification used the dedicated `admin_officer`
  session after release commit `a8f67b1c` reached `main`. Organization settings
  loaded without an alert, showed the existing Head Office branch as active,
  retained Archive, and retained the Add branch form with its module-inheritance
  explanation. No branch was created or archived for testing.

### Closure log — superseded organization-profile update

- Atlas showed `update_organization_profile` as present but unwired. Terrain
  inspection confirmed that it still wrote `organizations` and `audit_log`,
  but no page, Edge Function, script or database function called it.
- Before retirement, this RPC silently selected the actor's home organization.
  That contradicted the operating-workspace model: an administrator viewing an
  authorized root provider or branch must update the explicitly selected
  organization, not an implicit home record.
- Organization settings already uses `update_operating_branch_profile`. That
  authority accepts the selected operating organization, verifies both
  operating access and administration, supports owner, service-provider and
  branch organizations, locks the row, checks `updated_at`, validates the
  workflow mode, and writes audit evidence.
- The home-organization-only RPC, generated type and obsolete E2E handler were
  removed. Fifteen focused guards passed, the production web build passed, and
  the regenerated live snapshot reports 817 functions. Atlas dry-run moved
  158 -> 157 bounded gaps: 1 edge function, 101 RPCs and 55 tables. Exercise
  remains unclaimed because this closure removed a duplicate authority.
- Authenticated production verification used the dedicated `admin_officer`
  session after release commit `a6df14a0` reached `main`. Organization settings
  reloaded in the root provider workspace without an alert and retained the
  enabled Save details action. No profile field was changed merely to
  manufacture exercise evidence.

### Closure log — unsafe officer shift-stop bypass

- Atlas showed `stop_officer_shift` as present but unwired. It was not a
  harmless duplicate: the function could mark any owned in-progress shift
  complete without requiring its debrief, terminal stops and module tasks,
  closed dispatch jobs, resolved welfare alerts, or linked roster-slot update.
- The officer home and debrief flows already converge on `EndShiftDialog`.
  Before completion, that dialog loads `get_shift_end_readiness`, exposes the
  exact remaining work and safe next actions, records a missing debrief, and
  calls `complete_officer_shift` with expected-state concurrency protection.
- `complete_officer_shift` rechecks every condition under the shift lock,
  records advisory end-position evidence, completes linked roster state, and
  writes the canonical `officer_shift_completed` audit event. The bypass RPC
  and generated type were removed; historical migration evidence remains.
- Thirteen focused guards passed and the production web build passed. The
  regenerated live snapshot reports 816 functions. Atlas dry-run moved
  157 -> 156 bounded gaps: 1 edge function, 100 RPCs and 55 tables. Exercise
  remains unclaimed because no real shift was completed for testing.
- Production verification after release commit `b43d6d6a` used the dedicated
  `admin_officer` test identity with nonexistent shift IDs. The governed
  completion authority resolved and rejected the request as `Shift not found`;
  the retired bypass signature returned PostgREST function-not-found. Both
  probes were write-free, and neither is counted as successful exercise.

### Closure log — direct boundary writers and low-level setter privileges

- Atlas showed `save_site_boundary` and `save_zone_boundary` as present but
  unwired. Source and terrain inspection found no caller; both directly changed
  live geometry and wrote history outside the canonical proposal decision.
- Before retirement, these writers could leave verification state inconsistent
  with changed geometry. The zone writer also trusted caller-supplied zone and
  organization IDs without an access predicate. This contradicted the canon:
  every geometry change resets verification, stages as a proposal, is drawn for
  a person, and reaches live state only through acceptance.
- The direct RPCs, generated types and unused declarative remnants were
  removed. Site Boundary Review and Location House Map still use
  `propose_boundary`, `accept_boundary_proposal`, and explicit
  `verify_boundary`; accepted proposals continue through the low-level geometry
  setters with provenance and history.
- Validation exposed a coupled privilege defect: both `set_zone_geometry`
  overloads were executable by `PUBLIC`, `anon`, and `authenticated`, and stale
  declarative sources claimed the same for the site setter. A follow-up live
  migration now revokes browser execution from all three low-level setters and
  grants only `service_role`; the declarative evidence was aligned.
- Twenty-three focused boundary guards passed, the production web build passed,
  and the live snapshot reports 814 functions with no public/anonymous/
  authenticated setter grants. Atlas dry-run moved 156 -> 154 bounded gaps:
  1 edge function, 98 RPCs and 55 tables. Exercise remains unclaimed.
- Authenticated production verification after release commit `1e20b41b` opened
  Geofence workbench on an existing site without an alert. The UI showed the
  pending proposal, current/proposed map distinction, inspection confirmation,
  and Accept/Reject decision controls; no direct-save action was present.
  Bounded calls with nonexistent IDs confirmed both retired writers return
  function-not-found and an authenticated call to `set_zone_geometry` returns
  permission denied. No geometry or decision was changed.

### Closure log — superseded CRM boundary review

- Atlas showed both `get_crm_site_boundary_queue` and
  `manage_crm_site_boundary` as present but unwired. They formed an older
  CRM-only review surface that could directly install a point-radius boundary
  or verify it without the current proposal decision ledger.
- Geofence Workbench now reads the unified `get_geofence_review_queue` across
  sites and zones. Every human geometry source is staged through
  `propose_boundary`; the map shows current versus proposed geometry; acceptance
  or rejection records the decision; verification remains an explicit human
  confirmation.
- The obsolete CRM queue and mutator were dropped together, and their generated
  type entries removed. The historical migration remains as lineage, while the
  live schema and UI now expose one queue and one mutation authority.
- Twenty focused web guards and all 29 Atlas generator tests passed. The
  production web build passed, and the regenerated live snapshot reports 812
  functions. Atlas dry-run moved 154 -> 152 bounded gaps: 1 edge function,
  96 RPCs and 55 tables. Exercise remains unclaimed.
- Authenticated production verification after release commit `77a393db`
  reloaded Geofence Workbench twice. The pending proposal and Accept/Reject
  controls remained present with no UI alert; a one-off Leaflet reload error
  did not recur on the discriminating second reload. A bounded API check
  successfully invoked the unified review queue without reporting record data,
  while both retired CRM signatures returned function-not-found. No boundary
  decision or geometry was changed.

### Closure log — implicit CRM draft quote creation

- Atlas showed `create_crm_draft_quote` as present but unwired. It inferred the
  operating provider from the actor's home profile, while the current CRM page
  calls `create_crm_draft_quote_for_provider` with the administrator's selected
  and authorised operating provider.
- Before retirement, the duplicate authority could not preserve branch
  accountability, governed prospect eligibility, or the link between an
  agreement and its variation. Its presence also left two apparently valid
  ways to begin the same customer proposal.
- During current quote creation, the UI carries one retry identity and the
  selected operating-provider ID into the provider-aware function. That
  function checks organization access and provider type, validates prospect or
  active-client eligibility, validates agreement variations, creates only a
  draft, and records provider-attributed audit evidence.
- After creation, the existing draft remains the sole retry result for that
  provider and request ID. Quote-line authoring, proposal configuration, send,
  acceptance and agreement creation continue from that same draft.
- The implicit function, generated type and obsolete E2E fallback were removed.
  Historical migration evidence remains. Twenty-three focused CRM guards
  passed, the production web build passed, and the regenerated live snapshot
  reports 811 functions. Atlas dry-run moved 152 -> 151 bounded gaps:
  1 edge function, 95 RPCs and 55 tables. Exercise remains unclaimed.

### Closure log — governed CRM quote-line correction

- Atlas showed `update_crm_quote_line` present but unwired while the same draft
  pricing dialog already wired add and remove. Before this change, an
  administrator correcting a description, quantity, cost, or charge had to
  remove and reconstruct the line, losing its stable identity and making a
  routine pricing correction look like deletion and replacement.
- The live function already locked the quote, checked provider administration
  and expected draft status, bounded commercial values, retained the line ID,
  recalculated quote totals, and wrote an audit event. Its request ID was only
  descriptive, however: replay could repeat the update and audit event, and the
  audit metadata recorded only the new values.
- The function now uses a partial unique audit-receipt index and checks the
  request ID under the quote lock. The first correction returns
  `updated=true`; a replay returns the current totals with `updated=false`.
  Audit evidence records previous and resulting description, quantity, cost,
  and charge.
- During editing, the draft quote UI exposes explicit Edit, Cancel, and Save
  actions. Only the dimensions supported by the governed correction authority
  are editable. Kind and scope stay unchanged, errors remain visible, controls
  lock while saving, and the server-confirmed totals and success receipt are
  shown after persistence.
- After saving, the line reloads under the same ID and the CRM summary reloads.
  Desktop and mobile Playwright checks passed the cancel and save paths, 26
  focused guards passed, the production build passed, and a live rollback-only
  database check proved first-use and replay behavior without retaining any
  business or audit change. The live snapshot remains at 811 functions and now
  reports 719 indexes. Atlas dry-run moves 151 -> 150 bounded gaps:
  1 edge function, 94 RPCs and 55 tables. Exercise remains unclaimed because
  the successful database invocation was rolled back.

### Closure log — CRM quote commercial provenance

- Atlas showed `manage_crm_quote_commercial_source` present but unwired. The
  function could associate a draft quote with an eligible tender and active
  provider discount schedule, but no human task surface called it. The schema
  trace also found an important boundary: the association is provenance only.
  Quote totals are recalculated from quote lines and `quotes.discount_pct`; the
  selected schedule's scoped percentage or fixed-amount rules are not executed
  by this function.
- Before this change, the function had no request receipt or expected-state
  guard and its audit event retained only the resulting IDs. A retry could
  emit duplicate evidence, and an administrator could not see or maintain the
  provenance from the quote task.
- The authority now locks the quote, checks the caller's provider
  administration and expected draft status, validates that the tender belongs
  to the quote provider and client, and validates that the schedule is active
  and effective. A partial unique audit-receipt index makes changed-state
  retries safe. Audit metadata retains previous and resulting tender and
  schedule IDs. Execute remains revoked from `PUBLIC` and `anon`.
- During draft pricing, a compact Commercial basis section loads only eligible
  tender sources and currently effective provider plans. It uses labelled
  controls, stacks on mobile, disables unchanged saves, and says explicitly
  that linking provenance does not change quote-line charges or totals. This
  adapts the useful Trackforce pattern of keeping source instructions and the
  next accountable action inside the active task, without copying icon-heavy
  navigation or creating a parallel commercial workspace. The Finance Bureau
  wording now describes schedules as approved reference terms and no longer
  claims that their rules are automatically reflected in customer totals.
- After persistence, the server-confirmed source IDs remain on the same quote,
  the task reports that prices were unchanged, and reopening the quote reloads
  the provider and source context. Discount-rule execution remains a separate
  model gap; the UI does not imply that configured percentage, fixed-amount,
  module, Site or Zone rules have been applied.
- Twenty-seven focused guards, the production web build, and desktop/mobile
  Playwright workflow checks passed. The linked migration was applied and the
  live schema snapshot remains at 811 functions, with 720 indexes. A
  rollback-only database check proved first-use, replay and expected-state
  conflict behavior without retaining the temporary tender, schedule, quote
  association or audit event. Runtime exercise remains unclaimed.

### External design evidence — TrackTik guarding suite demo

- Source: TrackTik, “Power front-line security with the world’s leading
  solution,” hosted by Consensus,
  `https://play.goconsensus.com/b44186f57?demo=604c13a1-e9b0-4903-8de4-d42d9fdb6b3b`,
  4:43 video, retrieved 2026-10-15. The review used the on-page product
  demonstration and its auto-generated subtitle track; no proprietary asset
  or implementation was copied.
- Useful observed pattern: desktop configuration establishes Sites, schedules,
  workflows and report templates before the officer acts. The mobile surface
  then foregrounds patrols, checkpoints, acknowledged instructions,
  messaging, emergency contacts and safety actions rather than presenting an
  unrelated feature catalog.
- Useful observed pattern: submitted field reports enter a supervisor activity
  feed immediately, remain available in a consolidated operations register,
  and preserve delivery, edit and previous-version history. Patrol tours expose
  checkpoint completion and in-progress status to supervisors.
- FCM adaptation: keep the requirement beside its owning organization,
  accepted agreement and covered Site; show the current state and next safe
  action; use explicit success receipts; preserve audit evidence; progressively
  disclose configuration details. Continue developing live field progress and
  report-delivery/version history through FCM’s existing work, evidence and
  reporting spines.
- Rejected pattern: do not reproduce the demo’s icon-heavy dense desktop table,
  mobile feature-tile hierarchy, or implied universal automation. FCM must say
  which contract records actually drive an operational process and which are
  retained only as governed requirements.

### Closure log — governed agreement obligations

- Atlas showed `manage_crm_agreement_obligation` present but unwired. The live
  function could create, update and deactivate measurable requirements for an
  accepted operational agreement, but no human surface called it. A scoped
  R&M aggregate found one accepted operational agreement and zero obligations,
  so the gap was visible as absent contract configuration rather than hidden
  behind existing records.
- Before this change, requests had no replay identity. A retried create could
  collide on its code, while a retried update or deactivation failed the
  optimistic timestamp check after its own first success. Audit metadata
  retained only the resulting code and active state. Patrol-frequency JSON was
  accepted without a defined cadence shape.
- The authority now locks the owning agreement, requires provider
  administration and accepted operational status, and checks a unique
  organization-scoped request receipt before optimistic concurrency. A replay
  returns the persisted obligation. The server validates active covered Sites,
  proof types and a positive patrol count per shift, day, week or month. Audit
  evidence retains the request identity plus previous and resulting contract
  dimensions. `PUBLIC` and `anon` remain unable to execute the
  security-definer function.
- During agreement setup, administrators now use a labelled Requirements
  section beside Covered places, Service modules, Reporting and Client
  sharing. They can capture a stable code, type, description, covered Site,
  SLA, proof, escalation and patrol cadence; edit or reactivate an existing
  requirement; and explicitly confirm deactivation. Loading, empty, error,
  success, editing and inactive states are visible, and the five-section
  navigation becomes a readable two-column control grid on mobile.
- The UI states the automation boundary before entry and again for each type.
  Obligations do not create shifts, patrol stops, reports, notifications or
  officer post orders. Response requirements can be associated with downstream
  SLA evidence where work already carries an SLA; patrol cadence and report
  delivery remain contract requirements until their owning roster/report
  engines explicitly consume them.
- Five focused guards, the production build, 29 Atlas generator tests and the
  complete desktop/mobile create-confirm-cancel-deactivate workflow passed.
  The live schema remains at 811 functions and now reports 721 indexes.
  Rollback-only live verification proved save, replay, stale-state conflict and
  deactivation replay without retaining an R&M obligation or audit event.
  Runtime exercise remains unclaimed.

### Closure log — accountable dispatch runsheet changes

- Atlas showed `manage_active_shift` and `manage_shift_stop` as present but
  unwired. Source inspection disproved the simple interpretation: Dispatch did
  call both functions, but selected the RPC name through a runtime variable, so
  the generated terrain could not prove either caller.
- The UI trace found a real task-completion defect behind that mapping gap.
  “Change position” always sent `p_new_order = null`, so the server rejected
  every reorder. “Amend shift” collected only a reason and sent no amended
  note. Both actions used browser prompts, exposed no before/after context, and
  produced no visible success receipt.
- Before the change, the database locked only the selected stop and changed its
  number without resequencing sibling stops. Concurrent route edits could
  deadlock or leave duplicate route positions. Status-only optimistic checks
  did not protect a second edit when the first edit left status unchanged, and
  successful retries produced another mutation and audit event.
- The hardened authorities require a request ID, expected status and expected
  update timestamp. Stop changes lock the whole route in stable
  `stop_order, id` order, move intervening stops up or down, then place the
  selected stop. Attended and closed stops remain immutable. Shift changes
  reject terminal records, require real notes for amendment, and preserve the
  existing rule that a started shift cannot be cancelled.
- Both functions check their audit receipt before stale-state rejection, so a
  completed request can be retried safely. Audit metadata records previous and
  resulting status, health, notes, route position and update timestamp.
  Execution is revoked from `PUBLIC` and `anon`; authenticated callers still
  pass the function’s organization-admin check.
- During the task, the dispatcher now selects the current shift or stop, sees
  its status and progress, chooses the explicit change, supplies a route
  position or updated shift note plus an operational reason, and confirms in a
  responsive inline panel. The panel states that it changes the officer’s live
  run sheet, preserves completed attendance, and writes a before/after receipt.
  This adapts Trackforce’s useful “current tour + accountable next action”
  pattern without creating a second runsheet authority or copying its dense
  action-column layout.
- After a server-confirmed change, Dispatch refreshes the route and shows the
  exact outcome. Mobile now renders the same selected-shift and selected-stop
  controls inside its Shifts and Stops tabs; the first mobile acceptance run
  exposed that the old mobile branch omitted operator actions entirely, and the
  product path was corrected rather than weakening the test.
- Seven focused guards, the production build, and the complete desktop/mobile
  reorder-plus-amend workflow pass. The linked migration is applied; the live
  schema remains at 811 functions and now reports 722 indexes. Rollback-only
  live verification proved route resequencing, first-use, replay and stale
  timestamp behavior for both functions without retaining the temporary shift,
  stops or audit events. Atlas dry-run moves 148 -> 146 bounded gaps:
  1 edge function, 90 RPCs and 55 tables. Runtime exercise remains unclaimed.

### Closure log — reviewed contract evidence register

- Atlas showed `obligation_proof_artifacts` present but unwired. Dispatch
  contained only a TypeScript reference; there was no real read, write or UI
  task. Live verification found zero proof links, one active requirement marked
  as needing proof but carrying no evidence type, five completed
  agreement-linked stops, 74 GPS rows, and zero GPS rows linked to a shift.
  The legacy requirement is therefore shown as a configuration gap rather than
  silently corrected, and isolated coordinates are not relabelled as a GPS
  track.
- Before the change, authenticated callers retained broad direct table grants.
  A link had no request identity, correction state, source-time snapshot or
  governed withdrawal path. The table could accept an arbitrary source table
  and record ID without proving organization, agreement, covered Site,
  completion state or evidence compatibility.
- The table now carries an organization-scoped replay identity, active or
  withdrawn review state, source snapshot, update timestamp, reviewer,
  withdrawal reason and correction timestamps. One active source can satisfy a
  requirement only once; a withdrawn link remains in history and may be
  replaced after a new review. Direct browser grants are removed.
- Before attachment, `get_crm_obligation_proof_register` returns linked history
  and only eligible completed work. Timestamp evidence requires server-recorded
  arrival and departure on a stop whose shift uses an active location link for
  the same accepted operational agreement and whose Site matches the
  requirement scope. GPS-track evidence additionally requires at least two
  officer GPS points linked to the shift and captured inside the stop window.
  Photo, report, signature, other and legacy untyped requirements remain
  visibly unavailable until their owning source workflow exists.
- During review, the provider administrator opens Evidence register beside the
  requirement, sees the expected evidence type, current chain, eligible
  completed work, Site, officer and times, adds an optional review note and
  confirms the link. This adapts Trackforce’s useful supervisor activity and
  delivery-history pattern while keeping FCM’s agreement, place, shift and
  evidence spines authoritative. It does not copy a dense global activity grid
  or imply that all field activity proves every contract requirement.
- `manage_crm_obligation_proof` locks and revalidates the requirement and source
  on every attachment, requires provider administration and an accepted
  operational agreement, rejects unsupported proof types, and writes an audit
  receipt. Replays return the original result. Withdrawal requires the expected
  update timestamp and a reason, preserves the original link, records the
  correcting administrator and reloads the persisted chain.
- Ten focused guards, the production build, 29 Atlas generator tests and the
  complete desktop/mobile link-and-withdraw workflow pass. Both linked
  migrations are applied; the first regenerated live schema reported 813
  functions and 725
  indexes. Follow-up advisor hardening added covering reviewer indexes and
  removed the dead direct-table policies, bringing the final index count to
  727 and policy count to 903. Rollback-only live verification proved attach,
  attach replay, withdrawal and withdrawal replay without retaining an
  obligation, proof link or audit event. Database lint reported no finding for
  either new function.
  Advisor warnings for authenticated security-definer execution are
  intentional: the UI must invoke both RPCs and each function enforces its
  provider-admin check. The no-policy RLS notice is also intentional because
  browser table grants are revoked; zero-use index notices are expected while
  the live proof table remains empty.
  Atlas dry-run derives both RPCs as present and wired to
  `CrmAgreementObligationsPanel`, with concrete proof-table reads/writes and
  `exercised=null`; the existing proof table moves the bounded gap count
  146 -> 145. Runtime exercise remains unclaimed.
