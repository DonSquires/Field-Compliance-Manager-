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
