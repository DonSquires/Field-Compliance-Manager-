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
| `bob-reverse-job-step` | Generic reversal endpoint for `bob_job_runner` writes | No UI caller; service-role target mutation lacked tenant proof and domain correction semantics | Retired unsafe duplicate authority | Removed generic soft mutation and hard deletion. Approvals now exposes organisation-scoped job progress, outcomes, target receipts, and explicit domain-workflow guidance. | Closed |
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

### 2. Bob job recovery: unsafe generic reversal retired, review flow added

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

**Closed 2026-10-14**

- Live verification found two organisation-scoped, read-only job runs and zero
  rollback references, so there was no historical reversal receipt or target
  record to migrate.
- The endpoint was not wired because its generic inverse was not truthful:
  changing `is_primary`, `work_ready`, `verified`, or a record status does not
  reverse the domain event that created the record. Its service-role lookup and
  target mutation also lacked an organisation predicate, hard deletion bypassed
  domain retention rules, and a failed receipt update could follow a successful
  target mutation.
- The generic endpoint and hard-delete path are retired. Future target
  references are explicitly non-reversible until a dedicated domain workflow
  proves and records a safe inverse.
- `bob_job_runs` and `bob_job_rollback_refs` are now browser read-only.
  Administrators can see only runs in an authorised organisation; rollback
  references inherit scope by joining to the matching run. The former
  select-all and browser-write policies and grants are removed.
- Approvals Activity now includes a responsive **Job history** work area with
  goal, status, step progress, approval mode, clarification prompts, affected
  record receipts, stopped-state feedback, and a safe next action. Read-only
  jobs clearly state that no record changed. Write receipts direct the reviewer
  to the affected module's governed correction, void, or deactivation workflow
  instead of offering a generic destructive button.
- This adopts the useful Trackforce pattern of current progress plus durable
  delivery/edit history while preserving FCM's domain authorities and
  accountability chain. The removed Edge Function closes the final Edge
  Function gap; the expected bounded Atlas total moves 143 -> 142 with 0 Edge
  Functions, 89 RPCs and 53 tables. Runtime exercise remains unclaimed.
- The linked migration and targeted Edge Function deletion are applied. The
  regenerated catalogue remains at 398 tables, 813 functions, 726 indexes and
  now 896 policies after replacing four permissive policies with two scoped
  read policies. Database lint reported no new issue. Thirty-two focused
  governance/Atlas tests, the production build, and eight desktop/mobile
  role-and-history acceptance cases pass.
- The dedicated live `admin_officer` identity remains correctly excluded from
  Approvals and received zero job-history rows through its own JWT. This proves
  the officer-capable combined role does not gain the new review surface; no
  real-user impersonation or service-role result was used as UI evidence.

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

### Closure log — report-PDF policy wiring and duplicate CRM activity retirement

- The Trackforce-inspired delivery/version-history check found that FCM already
  has the relevant human workflow: report packs are reviewed, published, sent,
  exposed in the client portal and retained with current-PDF provenance.
  `can_read_current_report_pack_pdf` nevertheless appeared as an unwired RPC
  because the public-only schema snapshot cannot contain the live
  `storage.objects` policy that calls it.
- Live policy inspection proved that `bob_uploads_select` invokes the helper,
  and the existing custom-report SQL contract tests already verify current,
  stale, deleted and client-readable PDF cases. The correct closure was Atlas
  policy-call detection, not a second download button or a duplicate delivery
  page.
- Atlas now replays create/drop policy events for managed non-public schemas in
  migration order, keeps only the latest definition for each policy, and emits
  `secured_by` edges for referenced public functions. A regression fixture
  proves that the current `storage.objects` policy wires its helper while the
  function referenced only by a superseded policy remains unwired.
- The same gap trace identified `crm_activity_log` as an empty legacy duplicate.
  It had no reads or writes, only weak string references in three generic
  ingestion deny lists. The live CRM account workspace and governed creation
  and follow-up RPCs use `crm_account_activities`, which retains provider,
  account, agreement, replay, outcome and completion provenance that the old
  table lacked.
- Retirement is fail-closed: the migration refuses to drop
  `crm_activity_log` if an environment contains any row. The linked project had
  zero rows, so the duplicate table, its five policies, four constraints and
  stale generated type were removed. The three deny lists no longer carry a
  name for a table that does not exist; the canonical activity model was not
  changed.
- Before the cleanup, supervisors already used the existing report review and
  delivery UI, while the storage policy protected current PDFs invisibly.
  During access, the policy continues to permit only the object referenced by
  the caller-readable current report-pack row. After report edits, stale PDF
  objects remain unreadable until the governed renderer records a new current
  artifact. This preserves the useful Trackforce chain-of-custody pattern
  without adding an unsupported parallel report authority.
- The linked retirement migration is applied. The regenerated live catalogue
  reports 398 tables, 813 functions, 726 indexes and 898 policies. The
  production web build, 29 Atlas generator tests, database lint and live
  table/policy verification pass. Atlas dry-run reports
  `can_read_current_report_pack_pdf` wired from `storage.objects`,
  `exercised=null`, and no `crm_activity_log` capability. Bounded gaps move
  145 -> 143: 1 Edge Function, 89 RPCs and 53 tables.

### Closure log — explicit document-promotion execution calls

- Four approved document-promotion workflows were already complete for the
  human reviewer: credential, HR document, Site brief work unit and
  investigation link. Each presented target-specific fields, invoked a guarded
  function, returned an application receipt and reloaded the proposal state.
  Atlas nevertheless listed all four functions as unwired because the component
  assigned the RPC name to a runtime string before calling `supabase.rpc`.
- Before application, the existing UI still requires an approved proposal and
  explicit authoritative target details. During application, each branch now
  calls its exact generated RPC name with its exact argument shape. This makes
  the call statically provable, restores generated-type checking, rejects an
  unsupported target explicitly, and reports thrown failures while always
  clearing the busy state. No database function, authority or human task was
  duplicated.
- After success, the existing receipt and persisted proposal reload remain
  unchanged. After failure, the reviewer stays on the form with a visible error
  rather than being left in a busy state.
- The production build passes. Focused guards cover all four schema boundaries
  and the explicit UI calls. Atlas dry-run adds four component-to-RPC call edges
  from `pages/ApprovalsActivityPage`, keeps `exercised=null`, and moves bounded
  gaps 142 -> 138: 0 Edge Functions, 85 RPCs and 53 tables.

### Closure log — governed CCTV export approval, sealing and issue

- `approve_cctv_export` and `seal_cctv_export` were not dormant capabilities:
  the CCTV review workspace selected their names through a runtime variable.
  Atlas therefore showed both as unwired and generated TypeScript could not
  verify that each transition received the correct argument shape.
- The before/during/after trace exposed a deeper authority gap. Any
  authenticated user with ordinary organization access could approve, reject,
  seal and issue evidentiary material, and the approval RPC allowed callers to
  jump between lifecycle states. The linked project had zero export rows, so
  hardening did not reinterpret or mutate existing evidence.
- Before: an authorized reviewer creates a draft from accepted review events,
  with purpose, recipient scope, selected event IDs and a server-derived
  manifest hash. The draft author or an organization administrator may submit
  only a `draft`.
- During: only an active `admin`, `master` or `grand_master` authorized for the
  organization may approve or reject a `submitted` export. Approval, rejection,
  sealing and issue now have explicit confirmation language. Non-admin review
  users see an awaiting-administrator state instead of controls that fail only
  after invocation.
- After approval: only an organization administrator may seal the exact
  `approved` manifest. After sealing: only an organization administrator may
  issue it, and the RPC accepts only the canonical private
  `bob-uploads/cctv-exports/<org>/<export>/manifest-<sha256>.json` object after
  proving that object exists. Every transition records previous state and
  manifest provenance in `audit_log`.
- The UI now calls `approve_cctv_export` and `seal_cctv_export` explicitly,
  offers a visible rejection path and clears loading state in `finally` after
  returned or thrown failures. The existing issue receipt and short-lived
  signed download remain the after-state.
- The linked migration is applied and the regenerated catalogue remains at 398
  tables, 813 functions, 726 indexes and 896 policies. Sixteen lifecycle/UI
  guards, the production build and database lint pass. Atlas dry-run wires both
  RPCs to `pages/CCTVReviewPage`, retains the existing `issue_cctv_export`
  caller, keeps `exercised=null`, and moves bounded gaps 138 -> 136:
  0 Edge Functions, 83 RPCs and 53 tables.

### Closure log — governed dispatch insertion into one current run sheet

- The Trackforce-style check exposed two different gaps that must not be solved
  the same way. `insert_adhoc_stop` represented a useful job: add an urgent
  dispatch to the officer's current prioritized route. Its old implementation
  was unsafe and uncalled: a `SECURITY DEFINER` function executable by
  `PUBLIC` and `anon` accepted caller-supplied Site, module, SLA and GPS values,
  did not prove tenant, agreement, place, shift or officer alignment, and wrote
  no replay or audit receipt. `get_open_jobs` was instead an uncalled duplicate
  that mixed dispatch jobs and shift-coverage requests into one generic
  payload even though those workflows have different states, permissions and
  receipts.
- Before: a dispatcher selects a current published, accepted or in-progress
  officer run sheet and opens an eligible pending, dispatched or acknowledged
  job. The job and run sheet must expose the same service-agreement anchor. An
  unanchored or mismatched selection is explained before the action is offered.
- During: the job detail now presents one explicit **Add to selected run sheet**
  action. A second confirmation names the place and officer, explains that the
  route will be changed, requires a reason and offers **Keep job separate** as
  the safe exit. The RPC independently locks both records; proves
  organization, agreement, active agreement place, module and officer
  alignment; rejects stale job status or run-sheet timestamp; and replays the
  same client request without creating a second stop.
- After: the server appends one ad-hoc stop using the canonical Site or Zone,
  SLA and expected dwell time; links the dispatch job and officer; updates the
  shift stop count; invalidates the old patrol solve; and writes an audit
  receipt with request identity, reason and previous/resulting state. The UI
  reloads both the supervisor queue and selected run sheet and reports the new
  stop order. The separate dispatch and roster-coverage screens remain the
  canonical queues; `get_open_jobs` is dropped without `CASCADE` and removed
  from declarative schema and generated types.
- This adopts Trackforce's useful prioritized run-sheet and immediate
  supervisor-visibility pattern without copying a generic mixed job grid or
  keeping a hidden second insertion road. FCM's organization, agreement,
  place, shift and audit spines remain authoritative.
- Both linked migrations are applied. The regenerated catalogue has 398
  tables, 812 functions, 727 indexes and 896 policies. Thirty-five focused
  dispatch/governance guards, two production builds and linked database lint
  pass. Atlas dry-run wires `insert_adhoc_stop` to
  `pages/DispatchConsolePage`, proves its `patrol_solve_cache` write, removes
  `get_open_jobs`, keeps `exercised=null`, and moves bounded gaps 136 -> 133:
  0 Edge Functions, 81 RPCs and 52 tables.

### Closure log — governed staff availability and explicit roster-plan calls

- Atlas showed `apply_bob_roster_fill_plan` and
  `rollback_bob_roster_fill_plan` as unwired even though the approved-proposal
  executor already selected both names dynamically. Explicit calls now make
  the existing authority visible without changing its boundary: Bob may apply
  an approved plan only to draft roster slots, publication remains a separate
  human action, and rollback still refuses changed or published slots.
- `manage_staff_availability` was a genuine task-completion gap. Before:
  supervisors could see an availability warning but selecting it opened shift
  creation rather than a correction road. The RPC had no caller, accepted a
  request ID without replaying it, allowed deletion without proving the record
  belonged to the selected staff member, and authenticated clients retained a
  direct table-mutation bypass.
- During: the roster now opens a labelled Staff availability workspace for the
  selected person. A supervisor may record one date or a recurring weekday,
  distinguish available, preferred and unavailable time, choose all-day or a
  bounded period, and provide planning context. Unavailability requires a
  reason. Removal requires a separate reason and confirmation, with **Keep
  record** as the safe exit. Approved leave remains governed in People, Pay &
  HR rather than becoming a second leave authority.
- The database enforces one schedule shape, supported availability types,
  valid weekdays and valid all-day or part-day time bounds. Create and delete
  first check an immutable request receipt, deletion proves exact staff
  ownership, and audit metadata retains the record snapshot. Browser mutation
  is revoked; authenticated users retain organization-scoped read access and
  all writes travel through the governed RPC.
- After: the roster reloads the persisted record, future conflict checks start
  or stop using it, and the supervisor receives an explicit audit-receipt
  message. The correction workspace has responsive internal scrolling,
  readable mobile record cards and visible loading, empty, confirmation,
  success and failure states.
- This adapts Trackforce's useful desktop-preparation and immediate
  supervisor-visibility pattern before field execution. It does not create a
  second HR leave workflow, publish Bob's draft roster automatically or hide
  an alternate write road behind the UI.
- The linked migration is applied and the regenerated catalogue has 398
  tables, 814 functions, 728 indexes and 894 policies. Seven focused
  governance guards, the production build, web and E2E type-checks, linked
  database lint and the isolated desktop/mobile correction workflow pass.
  Rollback-only live verification proved create, create replay, delete, delete
  replay and cross-staff rejection with zero retained test records. Atlas
  dry-run wires all three RPCs, keeps `exercised=null`, and moves bounded gaps
  133 -> 130: 0 Edge Functions, 78 RPCs and 52 tables.

### Closure log — governed work-unit skill preparation

- Atlas showed `manage_roster_work_unit_skill_ids` as present but unwired while
  Roster Targets still called the older free-text requirement authority.
  Existing work units had no skill IDs or names, and the live organization had
  no catalog skills or staff-skill assignments, so replacing the authority did
  not reinterpret existing business requirements.
- Before: an administrator could enter comma-separated skill names only while
  creating a work unit. Existing units had no correction path, names were not
  bound to the organization skill catalog, and a failed follow-up call left the
  unit created without clearly reporting that partial result.
- During: creation and the new **Required skills** action use active canonical
  skill IDs. The dialog explains the assignment gate, keeps site induction in
  People, Pay & HR, offers **Keep current requirements** as a safe exit, and
  shows an honest governed destination when the organization has no catalog
  skills. The RPC serializes a client request, replays its audit receipt,
  checks the expected work-unit timestamp, locks the work unit, and rejects
  unknown, inactive or foreign-organization skill IDs instead of silently
  filtering them.
- After: the RPC persists canonical IDs and their names projection, advances
  `updated_at`, and records previous and resulting requirements plus the full
  record snapshot in `audit_log`. Roster Targets reloads the persisted unit and
  reports an explicit audit-receipt success. Existing assignment enforcement
  continues to reject new or changed assignments when the selected staff
  member lacks a current qualifying skill.
- This applies Trackforce's useful desktop preparation sequence: configure the
  capability required for work before deploying a person into the field, make
  the gate visible to supervisors, and retain a durable correction receipt. It
  does not copy a parallel credential model or conflate organization-wide
  qualifications with place-specific induction.
- The linked migration is applied and the regenerated live catalogue has 398
  tables and 813 functions. Thirteen focused roster guards, the production
  build, web and E2E type-checks, four desktop/mobile Playwright workflows,
  linked database lint, migration uniqueness, and 66 Atlas generator tests
  pass. Rollback-only live verification proved save, same-request replay,
  stale-state rejection, invalid-skill rejection and clearing requirements,
  with zero retained test catalog or audit rows. Atlas dry-run wires
  `manage_roster_work_unit_skill_ids` to `pages/RosterTargetsPage`, keeps
  `exercised=null`, and moves bounded gaps 130 -> 129: 0 Edge Functions,
  77 RPCs and 52 tables.

### Closure log - governed per-place toolset assignment

- Atlas showed `manage_location_module_assignment` as present but unwired, and
  a source sweep confirmed the gap was total: no web surface, no edge function
  and no other RPC referenced `location_module_assignments` anywhere. The two
  live rows were seeded with a null `created_by`, so no person had ever made
  this decision in the product. Canon's sentence - a guard on a place for a
  shift, with a toolset - had no toolset step.
- Before: a provider administrator could enable a module on the agreement and
  link Site or Zone facets, but could not say which toolset actually runs at
  which Location house. The only writer was also unsafe to wire: a retried
  submit silently re-wrote the effective window, and two administrators could
  clobber each other's dates without either being told.
- During: the operational work panel resolves the Location house behind each
  active agreement facet, reads the current assignment per house and per
  agreement-enabled module, and shows one of three honest states - on for a
  window, off for a window, or not set at this place. The action is explicit
  (`Turn on at this place` / `Turn off at this place`), states what the change
  means for officers, and offers `Keep current setting` as a safe exit. The
  replacement RPC serializes a client request, replays its audit receipt,
  requires the expected `updated_at`, and keeps every pre-existing containment
  check: accepted and in-term agreement, provider administrator, module
  enabled on the agreement, house owned by the client organisation, and an
  active Site or Zone facet under that house.
- After: the assignment carries the acting user in `created_by`, advances
  `updated_at`, and writes previous and resulting enablement, the effective
  window and the full record snapshot to `audit_log` against the client
  organisation. The panel reloads from the persisted row and reports an
  audit-receipt success that names the next actor.
- This applies Trackforce's useful configure-before-deploy sequence: settle the
  toolset for a place before anyone is sent there, keep the decision visible
  and reversible to a supervisor, and leave a durable receipt. It does not copy
  a device-centric module model; the place, the agreement and the client
  organisation stay the anchor.
- The linked migration is applied and the regenerated live catalogue has 398
  tables and 813 functions. Fourteen focused guards, the production build, web
  and E2E type-checks, migration uniqueness across 627 migrations, 29 Atlas
  generator tests, and linked database lint pass with no finding against the
  new function. Rollback-only live verification against a throwaway test
  identity - never a real person's account - proved save, same-request replay
  with a single audit row, reuse-for-a-different-module rejection, stale-state
  rejection, ungoverned-module rejection, reversed-window rejection and
  non-administrator rejection, with zero retained profiles, assignments or
  audit rows after rollback.
- Honesty note: that verification was rolled back, so it is not production
  invocation evidence. Atlas keeps `exercised=null` for this RPC; `wired` is
  the strongest claim available. Atlas dry-run records
  `components/CrmOperationalWorkPanel -calls-> rpc
  manage_location_module_assignment` and moves bounded gaps 129 -> 128: 0 Edge
  Functions, 76 RPCs and 52 tables.

### Closure log - governed fleet and equipment register

- Atlas showed `manage_asset` as present but unwired. The table was not dormant:
  proven flow reaches officer shift sign-out and return, administrator checks,
  and workshop work orders. Structural FK reach separately includes
  `asset_checks`, `shift_assets`, workshop and finance inventory/cost tables;
  those relations are blast-radius evidence, not proof that every pathway is
  exercised. Live verification found zero `assets`, zero `asset_checks`, and
  zero `shift_assets`, so the already-wired downstream actions had no register
  record to act on.
- Before: **Pay & Assets** displayed an empty fleet table and a check action for
  existing rows, but offered no way to create or correct one. The callerless
  RPC accepted retried writes without a replay receipt, had no optimistic edit
  guard, did not normalize or protect registration/serial identifiers, and
  recorded only a small post-write audit fragment.
- During: an administrator can add the first vehicle or equipment record from
  the existing **Pay & Assets** workspace, or explicitly edit a current row.
  The form distinguishes register state from shift assignment, keeps asset type
  immutable after registration, excludes a direct `in_use` transition, names
  the next inspection, validates the year, and offers **Keep current register**
  as a safe exit. Empty, error, saving, success, and narrow-screen states are
  explicit. A mobile browser test found that the taller dialog could place its
  confirmation below the viewport; the shared review dialog now has bounded
  scrolling rather than hiding the action.
- After: the governed RPC normalizes registration and serial identifiers,
  enforces organisation-level uniqueness, serializes each client request,
  replays the stored result, rejects stale edits, and records the previous and
  resulting full rows in `audit_log`. A table trigger advances `updated_at`
  with `clock_timestamp()` for every writer, including officer sign-out and
  return. This trigger was required because rollback verification proved that
  transaction-stable `now()` gave create and update the same timestamp and
  allowed a stale edit; the repaired path rejects it.
- This applies Trackforce's useful equipment-readiness sequence without copying
  a separate device product: register and inspect accountable equipment before
  deployment, show supervisors whether it is available, under maintenance,
  retired, lost, or currently in use, and leave assignment to the officer's
  governed shift sign-out/return path. The organisation remains custodian of
  its operational asset record.
- The linked migrations are applied and the regenerated live catalogue has 398
  tables, 814 functions, and 132 triggers. Thirty-three focused guards, the
  production build, web and E2E type-checks, desktop and mobile Playwright
  workflows, linked database lint, migration uniqueness across 629 migrations,
  and all 66 Atlas generator tests pass. Rollback-only live verification using
  a throwaway test identity - never a real person's account - proved create,
  create replay with one audit row, optimistic update, update replay, stale
  rejection, duplicate-serial rejection, direct-`in_use` rejection, and
  non-administrator rejection, with zero retained assets, profiles, or audit
  rows.
- Honesty note: rollback verification is not production invocation evidence.
  Atlas keeps `exercised=null`; `wired` is the strongest claim available.
  Atlas dry-run records `pages/RosterHRPage -calls-> rpc manage_asset` and moves
  bounded gaps 128 -> 127: 0 Edge Functions, 75 RPCs and 52 tables.

### Closure log - governed notice template versioning

- Atlas showed `manage_notice_template` as present but unwired while
  `notice_templates` already had proven reads from `generate-notice`,
  `generate-parking-notice`, and `generate-noise-evidence-package`.
  Live verification found zero templates and one parking chalk record. The
  downstream issue path therefore existed before an administrator had a
  working place to configure approved legal wording. `org_printer_settings`
  also has zero rows, but remains a separate gap because no runtime notice
  path currently reads it; wiring that setting alone would create dormant
  configuration rather than a working feature.
- Before: Organisation settings described notice templates as reference-only
  and claimed they would appear when a module was configured, but exposed no
  authoring action. The RPC silently defaulted missing legislation to the
  Resource Management Act, was neither replay-safe nor optimistic, allowed
  direct authenticated table writes through older policies and grants, and
  recorded only a partial audit fragment.
- During: an administrator with an enabled enforcement module can create the
  first template or explicitly create a new immutable version of the active
  one. The form requires the issuing authority, verified authorising Act,
  source-document location, body wording, and a human confirmation. Optional
  section, bylaw, fine, payment, and footer fields remain visible without
  inventing values. **Keep current template** is the safe exit. Empty, saving,
  error, success, historical-version, disabled-module, desktop, and mobile
  states are explicit.
- After: the governed RPC serializes each organisation/module/type stream,
  replays a client request without another version or audit row, rejects stale
  active-version expectations, preserves the prior row as inactive history,
  and records full previous/resulting snapshots. Direct authenticated writes
  are revoked. A validated table constraint rejects script, embedded-object,
  JavaScript-URL, and inline-event-handler HTML for every writer.
- This applies the useful Trackforce configure-before-deploy pattern without
  copying a separate notice product: supervisors approve sourced wording
  before field issuance, future generators consume the active version, and
  earlier templates and issued notices remain durable evidence.
- The linked migrations are applied and the regenerated live catalogue has 398
  tables, 814 functions, 735 indexes, 132 triggers, and 892 policies. Focused
  governance tests, web/E2E type-checks, the production build, and the
  desktop/mobile Organisation settings workflow pass. Rollback-only live
  verification using a throwaway test identity proved create, replay, version
  transition, stale rejection, source enforcement, unsafe-HTML rejection,
  direct-write revocation, full audit evidence, and authorization rejection,
  with zero retained templates, profiles, or audit rows.
- Honesty note: rollback verification is not production invocation evidence.
  Atlas keeps `exercised=null`; `wired` is the strongest claim available.
  Atlas dry-run records `pages/OrganizationSetupPage -calls-> rpc
  manage_notice_template` and moves bounded gaps 127 -> 126: 0 Edge Functions,
  74 RPCs and 52 tables.

### Closure log - organization notice printer defaults

- Atlas showed `manage_org_printer_settings` present but unwired.
  `org_printer_settings` was readable and the notice-print component already
  supported browser and Bluetooth printing, but administrators had no
  configuration surface and neither operational print path read the setting.
- Before: every notice print started independently at 58 mm. Parking oversight
  and breach review were also scoped to the user's home organization rather
  than the selected operating organization, so a provider working in a branch
  could not safely apply branch-specific settings.
- During: Organisation settings now loads the selected organization or
  branch's saved paper and connection preference. An administrator chooses
  58 mm, 80 mm, or A4 and browser/OS or Web Bluetooth, saves through
  `manage_org_printer_settings`, and sees success only when the returned values
  match the requested state. The screen explains that A4 is browser-only and
  prevents the invalid A4 plus raw-Bluetooth choice.
- After: parking oversight and breach review read records and printer defaults
  for the same selected operating organization. The shared print action marks
  the preferred connection, permits a one-print paper override, surfaces
  settings-load failure, and keeps A4 on the browser/OS path. ESC/POS output
  remains strictly limited to 58 mm and 80 mm instead of pretending A4 is a
  thermal format.
- This applies the useful Trackforce configure-before-deploy pattern without
  locking staff into one device: the organization supplies an accountable
  default, the field user can adapt one print to the available printer, and
  failure leaves a clear safe browser-print route.
- Focused organization, parking, breach, and printing guards pass together
  with the production web build and all Atlas generator tests. Atlas now
  derives a real page-to-RPC call and reads from the settings page and shared
  print hook.
- Honesty note: static wiring and tests do not prove a production invocation.
  `exercised` remains unchanged until governed runtime evidence exists.

### Closure log - scheduled field-work and retention exercise evidence

- The next Trackforce-style exception check found a map defect rather than a
  missing screen. `sweep_missed_field_work` already implements the required
  background road: it identifies late starts, contracted visits beyond their
  arrive-by time, shifts that ended without attendance, and active shifts
  running long; updates shift/stop facts; notifies the officer and branch
  administrators; and writes audit evidence. Atlas showed the RPC as unwired
  because its caller is `pg_cron`, not a page, Edge Function, trigger, or RPC
  that the static generator previously understood.
- Before: the live schedule was active every five minutes as
  `missed-field-work-sweep-every-5m`, but Atlas presented the operational
  safeguard as a gap. The same blind spot affected the active daily CCTV
  biometric-retention sweep. Closing either by adding a manual UI button would
  have duplicated the authority and weakened automatic exception handling.
- During: Atlas now derives current scheduler caller edges from ordered
  `cron.schedule`/`cron.schedule_in_database` declarations and removes a job
  when a later explicit unschedule is the final declaration. The runtime
  exercise collector separately reads active jobs and their latest successful
  `cron.job_run_details` receipt through the governed read-only Management API.
  Static schedules prove `wired`; only successful run receipts prove
  `exercised`.
- After: live Atlas records
  `scheduler/missed-field-work-sweep-every-5m -calls->
  sweep_missed_field_work` and
  `scheduler/cctv-biometric-template-expiry-daily -calls->
  expire_cctv_biometric_templates`. Both RPCs are `wired=true` and
  `exercised=true`. The missed-work job's twenty sampled runs all succeeded,
  including the 20:50 NZDT run on 2026-10-15. Thirty-day redacted evidence
  includes seven late-start audit events, eighteen missed-shift audit events,
  and corresponding officer/supervisor notification receipts; no personal
  record values were exported.
- This adopts Trackforce's useful unattended exception-monitoring and immediate
  supervisor-visibility pattern without inventing a second operations queue.
  Officers still use their schedule, supervisors use the roster exception
  workflow and notifications, and clients receive the existing service
  delivery truth. The scheduler is the road, not another product surface.
- Focused scheduler parsing and exercise-evidence tests pass. The scoped live
  Atlas refresh wrote two scheduler features and two caller edges; runtime
  calibration promoted exactly the two RPCs backed by successful cron
  receipts. Bounded gaps move 126 -> 124: 0 Edge Functions, 72 RPCs and 52
  tables.

### Closure log - multiline identity evidence review routing

- The next Atlas candidate was `review_nzta_mvr_identity_evidence`, which
  looked unwired even though the identity workspace visibly offered **Approve
  NZTA check and update records**. The review action selects between the NZTA
  and canonical identity-review RPCs through a multiline ternary expression.
  The extractor only recognised single-line conditional calls, so this was a
  map gap rather than a missing Trackforce-style operator action.
- Before: the operator could open an identity document, compare the private
  source, and submit the governed review, but Atlas omitted the NZTA write
  edge. That understated the real accountability path and made the vehicle
  evidence workflow look incomplete.
- During: the existing workspace still requires the human source comparison,
  approved fields, review notes, and the governed RPC. No new button, direct
  table write, or automatic identity promotion was added. The Atlas parser now
  accepts multiline conditional RPC targets and records both possible governed
  review commands.
- After: live Atlas records
  `components/IdentityRecordsWorkspace -calls-> review_nzta_mvr_identity_evidence`
  and the corresponding canonical review edge. Both RPCs are `wired=true`;
  `exercised` remains `null` because source tests and static extraction are not
  invocation evidence. Bounded gaps move 124 -> 122: 0 Edge Functions, 69 RPCs
  and 53 tables.
- This preserves the useful Trackforce principle of a visible, accountable
  supervisor review step without creating a second identity queue. The
  evidence source, human decision, canonical person/vehicle link, and audit
  receipt remain the authoritative FCM path.
- The multiline extractor regression and full Atlas refresh test file pass
  (32 tests). No schema or production runtime behavior changed.

### Release candidate - incident people readback

- Live Atlas identified `get_incident_people` as present but unwired while
  `record_incident_person_identity` already had callers in the identity
  workspace and officer field report. Schema inspection confirmed both use the
  same tenant-scoped `incident_person_links` path and the read RPC repeats the
  existing assigned-officer/admin authorization check.
- Before: an authorised identity reviewer could select an active incident and
  link the current canonical person with an involvement role and identity
  basis. The write returned a success message, but the workspace did not show
  who was already linked, whether the person was staff or a reviewed identity,
  or whether a newly stated identity still needed review.
- During: selecting an incident now calls `get_incident_people` and shows an
  accessible loading state, a local error state, the empty state, or the
  current people. Each row exposes the name, involvement role, source kind and
  review state. A request sequence guard prevents a slower response for the
  previous incident from replacing the current selection.
- After: a successful `record_incident_person_identity` call refreshes the
  same governed readback before releasing the busy state, so the user receives
  both the write receipt and visible persisted outcome. No direct table read
  or write was introduced.
- This adopts the useful Trackforce pattern of keeping the incident roster
  visible beside the action, while preserving FCM's canonical-person,
  source-provenance and manual-review rules. It does not add a second incident
  queue or imply that a stated identity is verified.
- Verification: the focused identity-workspace guard passes (6 tests), the
  web and E2E TypeScript check passes, the production web build passes, and the
  Atlas suite passes (32 tests). The dry-run manifest adds the component caller
  for `get_incident_people`.
- Release-state honesty: the live bounded count is 123 while this branch is
  not yet deployed and the production refresh therefore still omits the
  multiline NZTA review caller. Once this branch is merged and the production
  Atlas refresh runs, the two source-backed corrections should reduce that
  same baseline to 121. Neither RPC may be marked `exercised` without runtime
  invocation evidence.

### Owner ruling - Deputy sample parser is not an operational gap

- Owner ruling 2026-10-16: Deputy roster exports were introduced as sample data
  for build and test work, not as a live roster integration.
- Before: Atlas correctly showed `apply_deputy_roster_import` as present and
  unwired. The absence of a screen was intentional, but the public-schema RPC
  still granted authenticated administrators a production mutation path into
  workplaces, work units, staff external references, roster slots, leave,
  import batches and audit records. That contradicted the sample-only boundary.
- During: the offline parser and source-shaped tests remain available without
  database access. A forward migration drops only the mutating RPC. Shared
  `external_refs` columns remain because they are schema evidence fields, not
  proof that Deputy is an operational integration.
- After: the production schema and generated database types no longer advertise
  the Deputy apply RPC. Atlas must retire the RPC and its outgoing flow edges
  rather than inventing a caller or adding an import button.
- Trackforce consideration: imports into an operational roster require visible
  source review, mapping exceptions, human approval, idempotent apply and a
  durable receipt. The sample parser supplies test evidence for those future
  acceptance criteria; it is not itself that governed workflow.

### Closure log - governed tender source attachment

- Live Atlas showed `attach_tender_document` present but unwired while the CRM
  portfolio already read and displayed `tender_documents`. Direct authenticated
  inserts are revoked, so the visible Finance/Tenders surface could show source
  evidence but offered no governed way to add it.
- Before: an administrator could see a tender and any existing source files but
  had to leave the task without a safe next action. The gap was operational,
  unlike the retired Deputy sample importer, because the source evidence table,
  read path, tenant-scoped RPC and downstream tender view were all live.
- During: Finance now offers **Attach tender source** when tenders exist. The
  form requires a tender and file, constrains the document type to the schema
  vocabulary, accepts an optional source locator, rejects files over 25 MB,
  records a SHA-256 hash, uploads to a unique tenant/tender path with overwrite
  disabled, and calls only `attach_tender_document`.
- Failure is explicit at hashing, upload and registration. If registration
  fails after upload, the UI attempts object cleanup and reports a cleanup
  failure separately rather than presenting success or silently leaving the
  user uncertain.
- After: a successful receipt says the source is attached as **unreviewed**
  evidence, closes the form, and reloads the account so the persisted document
  appears under its tender. Upload does not accept the document, alter tender
  status, or bypass the later human review decision.
- Trackforce consideration: the useful pattern is the source document beside
  the commercial task with immediate receipt and visible state. FCM preserves
  stronger provenance and review separation rather than treating file presence
  as operational approval.
- Verification: the portfolio guard passes (13 tests), the Atlas suite passes
  (32 tests), web and E2E TypeScript checks pass, and the dry-run manifest adds
  `components/CrmAccountWorkspace -calls-> attach_tender_document`. Exercise
  remains unset without an authenticated runtime invocation.

### Closure log - source-backed Parking zone rule authoring

- The Trackforce-style configure-before-deploy check found a real task gap in
  the Parking zone workspace. The field scanner already consumes the zone's
  effective time limit and disabled-bay multiplier, but the administrator
  surface did not provide a governed way to establish those values from the
  posted sign before officers used the zone.
- Before: a Parking zone could reach field use with missing rule provenance and
  no required sign photograph. Directly editing `location_zones` would have
  bypassed tenant, agreement/place authority, optimistic concurrency, replay
  protection, and audit evidence.
- During: the zone workspace now requires a whole-minute posted limit, a
  bounded disabled-bay multiplier, an image upload to the tenant/zone-scoped
  private `scans` path, and explicit human confirmation that the values match
  the photographed sign. **Keep current rule** is the safe exit. The governed
  RPC locks the zone, proves the administrator and canonical place authority,
  validates Parking module identity and provenance, rejects stale versions,
  and accepts only JPEG, PNG, or WebP evidence stored under the governed path.
- After: one immutable configuration version is written, the previous and
  resulting rule snapshots are recorded in `audit_log`, and a replayed request
  returns the same resulting row without a second update. The scanner's
  effective-rule path remains the consumer, so the setup action drives the same
  operational rule used in the field rather than creating a parallel setting.
- This adopts Trackforce's useful site/rule readiness sequence without copying
  its product model: the canonical zone, place, module profile, sign evidence,
  field scan, and audit receipt remain FCM's authorities. No enforcement claim
  is made from an unverified or missing sign source.
- The linked migration is applied and the live schema snapshot is regenerated.
  Six focused governance tests, eight desktop/mobile geofence workflow tests,
  web/E2E type-checks, and the production build pass. Atlas records
  `pages/ZoneDetailPage -calls-> rpc manage_parking_zone_rule`; runtime
  exercise remains `null` because the acceptance fixture is not production
  invocation evidence.

### Closure candidate - consequential import-row review

- Atlas showed `review_file_import_row_proposal` present but unwired. The File
  System already owned source upload, persisted batch review and human column
  mapping, but consequential row proposals had no visible read or decision
  surface.
- Before: a tenant import administrator could inspect batch-level counts and
  mappings, yet could not compare an individual source row with Bob's proposed
  target or invoke the existing reason-required approve/reject boundary. The
  task stopped before the action that can create the governed target.
- During: the selected batch now loads only its RLS-scoped
  `file_import_row_proposals`. Each row shows source identity, source values,
  proposed payload, target type, confidence, current state and applied target
  receipt. Proposed rows require a written evidence reason and expose separate
  **Approve and apply** and **Reject proposal** actions through
  `review_file_import_row_proposal`. Batch approval is a stop-line while any
  consequential row remains proposed, preventing the parent review from closing
  before its row decisions are complete; batch rejection remains available.
- After: the returned persisted row replaces the proposal in place. Approval
  states that the governed target outcome and audit receipt are recorded;
  rejection states that no proposed target was applied. Reviewed rows retain
  their reason and applied target identifier where one exists.
- Trackforce consideration: this follows an exception-workbench pattern: show
  the source, proposed outcome, confidence, decision owner action and durable
  result together without adding bulk approval or treating batch approval as
  permission to apply every row.

### Closure candidate - perception evidence field review

- Atlas showed `review_perception_evidence_field` present but unwired while
  `components/BobStudio` already read `perception_evidence_fields`. The Studio
  displayed machine authority and warned that administrator comparison was
  still required, but it stopped before the governed human decision.
- Primary actor: an administrator working in the operating organization's Bob
  Studio. The job is to compare a machine-derived field with its source before
  that field can be treated as human approved or excluded from authoritative
  use.
- Before: the shared evidence envelope, normalized candidate and authority
  state were visible. Source locations, conflicts and calibrated confidence
  were not visible, and there was no action for completing the stated manual
  review.
- During: each attached evidence envelope now presents its fields one at a
  time with candidate value, confidence, source locations, conflicts and
  authority state. Approve, reject and needs-more-context decisions require a
  written comparison rationale and call only
  `review_perception_evidence_field`. There is no bulk action and no direct
  table mutation.
- After: the returned field replaces the visible candidate in place. The
  envelope remains `manual_review_required` while any field still requires
  review and becomes `complete` only after the last field is resolved. The UI
  states whether the field was approved, rejected or left pending more
  context; the database preserves the append-only review and audit receipts.
- Trackforce consideration: this is an exception-review lane rather than a
  confidence dashboard. It keeps the source, conflict, accountable decision,
  reason and durable outcome together and prevents machine consensus from
  looking like human authority.
- Exercise honesty: component tests prove the request and persisted readback
  contract, but they do not prove a production invocation. Atlas `exercised`
  must remain unset until an authorized administrator reviews a real field.

### Closure candidate - superseded CRM and rate RPC retirement

- Atlas showed three authenticated RPCs as present but unwired:
  `get_crm_onboarding_queue`, `manage_crm_onboarding_stage`, and
  `manage_rate_rule`. Repository search, generated callers and E2E fixtures
  confirmed that the active product instead uses
  `get_crm_onboarding_workspace`, `manage_crm_onboarding_workflow`, and
  `manage_operating_branch_rate_rule`.
- Before: PostgREST advertised two parallel onboarding reads, two parallel
  onboarding mutation paths and two parallel rate-rule mutation paths. The old
  APIs could not represent the current named owner, stage note, immutable
  workflow history, invitation/client-seat state, descendant-provider reach,
  explicit operating branch, or payroll role code.
- During: a forward migration drops only the three narrower signatures.
  Historical migrations remain unchanged as lineage evidence. Stale E2E aliases
  and Atlas expectations are removed so tests exercise the same single APIs as
  production.
- After: PostgREST no longer advertises the old commands. The richer
  replacements remain advertised and are still the only browser callers.
  Live-regenerated schema and generated TypeScript definitions no longer claim
  that the retired functions exist.
- Trackforce consideration: operational certainty comes from one accountable
  queue and one governed command path. Leaving callable predecessor APIs beside
  ownership-aware workflows creates an invisible bypass and ambiguous support
  evidence even when no current screen calls them.
- Atlas treatment: retire the three capabilities and their outgoing internal
  edges as legacy. Do not invent UI callers. Their replacement RPCs remain
  present and wired; exercise state is unchanged.

### Closure candidate - governed Bob reply feedback

- Live Atlas showed `bob_message_feedback` present but unwired and live
  verification found zero rows. The table comment explicitly assigned
  per-reply helpful/improvement feedback to BobPanel, but the canonical chat
  rendered no controls and never read persisted feedback.
- Before: users could see Bob's answer, confidence, workflow state and safe next
  action, but had no durable way to say whether the answer helped. The table's
  direct-write policy also trusted caller-supplied organization, conversation
  and message identifiers independently, so wiring a browser upsert would have
  preserved a cross-tenant integrity weakness.
- During: each assistant reply now offers **Helpful** and **Needs improvement**.
  Improvement feedback opens a bounded optional-note editor with **Save
  feedback** and **Cancel**. Loading, selected, saving, success and error states
  remain beside the rated reply. A helpful decision saves immediately; a later
  decision updates the same user/message receipt rather than creating
  duplicates.
- The browser calls only `manage_bob_message_feedback`. The command derives the
  organization, conversation and user from the persisted assistant message,
  requires that the caller owns that Bob conversation and still has
  organization access, rejects non-assistant messages and invalid ratings, and
  bounds notes to 1,000 characters. Direct authenticated insert, update and
  delete privileges are revoked.
- After: reopening or switching the conversation reloads the user's persisted
  choice and optional improvement note. The returned row must match the
  requested message and rating before the UI reports success. Existing
  administrator read policy remains available for a later organization-wide
  quality-triage surface; this change does not invent aggregate quality claims
  from a single rating.
- Trackforce consideration: the useful pattern is exception feedback attached
  to the exact operational response, with an accountable person, optional
  context, durable current receipt and explicit failure. FCM keeps that
  feedback tenant-bound and does not let a rating mutate the source message or
  silently become training authority.
- Verification: 54 focused BobPanel and governance tests pass. Rollback-only
  live verification proved derived tenant linkage, helpful-to-improvement
  update with one retained receipt, invalid-rating rejection, user-message
  rejection, another-user rejection and direct-write revocation, with zero
  retained profiles, conversations or messages. Static and rollback evidence
  do not prove a real production user rated a reply; Atlas `exercised` remains
  unset.

### Closure log — single governed approval queue

- Atlas showed `get_my_pending_proposals` as present but unwired. Source
  inspection found no page, Edge Function, script or database function calling
  it. Its comment identifies it as an older per-user bell query that returns
  only pending `bob_agentic_actions`.
- The current Approvals workspace uses `get_approvals_activity`. It preserves
  the same trigger, attribution, assignment and organization-tree visibility,
  while also returning lifecycle history, named actors, decision ownership,
  result receipts, errors, pagination, filters and an explicit `can_decide`
  authority result.
- Wiring the older query would create a second, partial approval inbox and
  expose a security-definer API to `PUBLIC` and `anon`. The obsolete function
  and its stale declarative source are therefore retired. Historical migrations
  remain as lineage; `get_approvals_activity` remains the single governed
  approval queue.
- Two focused retirement guards, the production web build, all 72 Atlas and
  retirement tests, and the 638-version migration uniqueness check pass. The
  live snapshot reports 813 functions; the local Atlas manifest moves from
  1,364 capabilities and 7,387 edges to 1,363 capabilities and 7,386 edges.
- PostgREST now returns function-not-found for
  `get_my_pending_proposals(integer)` and still resolves
  `get_approvals_activity(integer,integer,text[],text[])`. Removing a duplicate
  read API is not successful user exercise, so no exercise state is claimed.

### Closure log — obsolete CRM account views

- Atlas showed `crm_account_health` as present but unwired. Its 90 returned
  rows were derived organization rows, not persisted health assessments. The
  view hardcoded every account to zero active breaches and labelled a count of
  user profiles as active roster, so wiring it would create false operational
  certainty.
- Atlas marked `crm_account_list` wired only because production comments and an
  obsolete helper said the view did not exist. No runtime query used either
  view. The current CRM workflow instead scopes accounts through
  `get_crm_provider_portfolio`, reads canonical organizations and related sites,
  contacts, quotes and invoices, and gets readiness from
  `get_crm_organization_readiness`.
- Both unused derived views, their stale declarative sources and the obsolete
  schema helper are retired together. No business row is deleted. The provider
  portfolio, readiness blockers, next actions, receivables and persisted
  lifecycle receipts remain the single current workflow.
- Trackforce consideration: dashboard health must expose real exceptions and
  accountable next actions. A green zero or roster count inferred from the
  wrong entity is worse than an explicit unavailable state; FCM will not
  present placeholder metrics as operational truth.
- Two retirement guards, 38 focused CRM/schema tests, all 72 Atlas and
  retirement tests, the production web build, and the 639-version migration
  uniqueness check pass. The live catalog remains at 398 tables and 813
  functions and moves from 20 to 18 views. The local Atlas manifest moves from
  1,363 capabilities and 7,386 edges to 1,361 capabilities and 7,383 edges.
- PostgREST now returns table-not-found for both retired views while canonical
  `organizations` remains available. Removing unused derived surfaces is not
  successful user exercise, so no exercise state is claimed.

### Closure log — SQL view dependency terrain

- Atlas showed `person_permit_vehicles` as present but unwired even though the
  live `person_permits_fieldwork` view reads its 92 vehicle links and both
  officer and administrator vehicle-search surfaces consume that governed,
  redacted view. This was a map-extraction gap, not a missing screen.
- The generator previously inventoried views as entities but did not derive
  their `FROM` and `JOIN` dependencies. It now emits live-schema `reads` edges
  from each current public view to referenced tables or views, ignores
  non-public schemas, CTE aliases and self-references, and masks comments,
  quoted literals and dollar-quoted function bodies before parsing.
- Against the current live snapshot this produces 58 coherent edges across 18
  views. Three bounded gaps become newly proven wired:
  `person_permit_vehicles`, `module_event_place_matrix`, and
  `house_event_anchor_projection`. The latter two are policy/accountability
  projection inputs already consumed by current derived views.
- Trackforce consideration: an operational console may present a joined or
  derived read model, but Atlas must still show which authoritative records
  support it. A view is a proven read path, not runtime exercise and not proof
  that the underlying record was created correctly.
- All 72 Atlas generator tests pass, including synthetic CTE/literal exclusion
  and current-schema assertions for permit, policy and accountability views.
  The dry-run manifest remains at 1,361 capabilities and moves from 7,383 to
  7,441 edges. Applying these additions should move the bounded live gap count
  from 113 to 110; final live verification remains required after release.
## 2026-10-16 — Retire the unused generic rule-snapshot mutation API

- **Expected:** effective-rule snapshots form an immutable operational receipt
  of the rule context that governed a field event. Each live event path should
  have one accountable capture mechanism, rather than a second generic write
  API that can manufacture equivalent receipts without the event transition.
- **Present before:** `capture_effective_rule_snapshot` was exposed to
  authenticated callers and could insert or replace
  `effective_rule_snapshots`, but Atlas and source inspection found no caller.
  All sampled live snapshots were created for `observations`, whose database
  trigger writes the ledger directly through
  `capture_observation_effective_rule_snapshot`.
- **Change:** retire the unused generic RPC while preserving the snapshot
  table, its existing records, and the observation trigger. Future event types
  must add an explicit governed capture path tied to their own transition
  instead of reviving a context-free mutation endpoint.
- **Trackforce consideration:** durable operational receipts are valuable only
  when the action that created them is attributable. Removing an unused
  alternate writer strengthens the chain from field observation to immutable
  rule context without adding a screen or claiming runtime exercise.
## 2026-10-17 — Recover unqualified RLS policy dependencies

- **Expected:** Atlas must show when a table's row-level security policy calls a
  helper RPC. That `secured_by` edge is part of the live access path, not a UI
  reference and not runtime exercise.
- **Present before:** the policy parser detected schema-qualified calls such as
  `public.org_access_allowed(...)`, but its unqualified-call expression consumed
  the opening parenthesis after `USING` or `WITH CHECK`. The immediately nested
  helper was therefore skipped. Live policies protecting access presets,
  observations, noise, smoke, biosecurity, and infringement records called
  `is_master_or_above`, `user_has_task_entitlement`, or
  `is_enforcement_operator_for_org`, while all three helpers were incorrectly
  reported as unwired.
- **Change:** use a non-consuming negative lookbehind for unqualified SQL
  function calls. Synthetic coverage now uses an unqualified policy helper, and
  current-schema assertions prove the access-preset and task-entitlement
  dependencies.
- **Trackforce consideration:** field systems rely on trustworthy permission
  boundaries as much as visible task controls. Recording the policy-to-helper
  relationship makes the real stop-line visible without claiming that any user
  has exercised it or inventing a new screen.
## 2026-10-17 — Classify active scheduler features as wired sources

- **Expected:** an active `pg_cron` declaration proves that its scheduler
  feature has a real outbound execution path. The declaration establishes
  `wired`; only a successful `cron.job_run_details` receipt establishes
  `exercised`.
- **Present before:** Atlas correctly derived scheduler-to-RPC call edges for
  slow Builder-job warnings, CCTV biometric expiry, and missed-field-work
  sweeps. Their RPC targets were wired, but the scheduler source capabilities
  themselves were reported as unwired because feature capabilities normally
  require an inbound caller.
- **Change:** a live-schema scheduler source now contributes the explicit caller
  summary `active pg_cron schedule`. Retired schedules remain absent because the
  ordered migration replay already removes them. Runtime exercise remains null
  unless the separate governed receipt importer proves a successful run.
- **Trackforce consideration:** automatic exception sweeps are operational
  actors, not screens waiting for a button. Showing their declared execution
  road—and separately their last successful traversal—supports reliable missed
  work, retention, and stalled-job monitoring without inventing manual actions.
