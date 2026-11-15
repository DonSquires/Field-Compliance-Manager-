# Build recovery queue

Updated: 2026-11-15. Owner: Don Squires. Coordinator: this recovery session.

This is the requested priority list for interrupted chats, unfinished branches,
Builder/Vibe work and task-completion gaps. It supplements, rather than replaces,
[the rebuild plan](REBUILD_PLAN.md). Every item needs a recorded disposition:
completed with evidence, superseded with proof, or blocked with a specific next
action. An open chat, green preview, merged PR or Atlas flag is not completion.

## Working rules

- Preserve uncommitted work. A crashed chat is not permission to discard its files.
- Do not interrupt active Builder/Vibe work. VB-17 has now closed; review its
  proposal and check VB-18 separately rather than assuming one fixes the other
  or starting duplicate work.
- Evaluate UX from the user's job: where to start, what to enter, how records
  relate, where to find them again and what confirms completion. Existing page
  boundaries and historical UI canon are hypotheses, not acceptance evidence.
- The owner's 2026-11-15 direction explicitly reopens inherited UI/UX decisions.
  Record justified changes in the owning design document before contradictory
  code stands. Preserve access, privacy, audit, financial and safety safeguards.
- Trace Atlas together with schema and source. Classify gaps before wiring them;
  internal/server-only capabilities do not all need screens. Keep data-flow
  reach separate from FK structure and do not claim invocation from `exercised`.
- Use focused regression tests and before/during/after evidence. Release only
  through the protected PR path and governed single-writer deployment lane.

## P0: stop incorrect consequential behavior

- [x] **R01: deployed rejected-timesheet hours inflation.** PR #513 loads the
  saved total as a new additive adjustment. Reproduce in a focused test, preserve
  the saved adjustment, verify the submitted RPC argument and release the fix.
  PR #515 implements the repair; 27 focused tests independently pass and its
  reviewed head is signed/verified. Merged as `0bf8d171`; all three verification
  jobs passed and production deployment `7800351726` succeeded. Independent
  offline desktop/mobile officer workflows: 30 passed. No historical payroll
  records were changed; authenticated live financial writes were not tested.
- [x] **R02: misleading timesheet Approve/Cancel controls.** Current handlers
  only show notices. Remove false officer actions rather than granting payroll
  powers; preserve real administrator review and explain the actual state.
  Released in PR #515, without a new officer approval permission.

## P1: recover current work and restore task completion

- [ ] **R03: VB-17 / VB-18.** VB-17 closed and produced PR #519, reviewed at
  `15962555`. Its existing integration lane merged it as `1aa9f1e9` at
  08:48:03 UTC while the reported branch-review blocker remained: both
  `get_branch_timesheet_queue` overloads omit the revision required by the
  correction RPC, while the caller invents revision one when it is absent.
  The browser fixture supplies a revision the actual queue does not return.
  Live catalog inspection confirms the missing projection. The finding is
  recorded on [the proposal](https://github.com/DonSquires/Field-Compliance-Manager-/pull/519#issuecomment-6891754579);
  the pre-repair live queue contract omitted revision. The forward projection
  repair in PR #523 is verified: the disposable PostgreSQL regression first
  failed with both revisions absent, then passed using the actual queue's
  revision seven to correct hours, returning revision eight and rejecting
  stale reuse after reapproval. Date/staff filters, unauthorized access,
  correction audit history and exact queue execute ACLs remain covered.
  All runtime/migration, web and offline browser CI checks passed. Protected
  rebase merge `e4926b92` completed at 09:18:16 UTC. Live migration
  `20261115090108` and both revision-bearing result signatures are verified,
  with original ACLs/security/search_path retained. Automatic catalog PR #524
  merged as descendant `80e61fbb`; the existing timer recorded its successful
  governed receipt at 09:27:55.897 UTC. Production web deployment `7801337547`
  separately succeeded at 09:19:07 UTC. No live payroll writes were performed.
  The exact VB-18 lookup still returns no row; the owner's report remains
  unresolved, not disproved.
- [ ] **R04: location checkpoint reads and edits.** Preserved
  `wt-checkpoint-map-fix` untouched. Both actual reader and manager RPCs fail
  for an authorized synthetic actor because their output `id` conflicts with
  an unqualified profile lookup. The error blocks the operational place
  editor's loading path. A new forward migration qualifies the actor and
  manager lookups; normalized definitions match the originals except for
  table aliases/qualified columns. Permanent disposable PostGIS regression
  failed on the actual ambiguity before the repair, then passed direct and
  legacy Site/Zone reads, custody filtering, denied officer/inactive/foreign
  access, create/replay, rename/status, geometry verification reset, history,
  audit and unchanged execute ACLs. Five focused tests pass. Authority helpers
  are synthetic fixtures, not proof of full production policy or visual map
  acceptance. Signed PR #525 has 22 passing Linux integration tests; all CI
  checks passed and protected rebase merge `ff812763` completed at 09:39:01 UTC.
  Migration `20261115091507` is now ledgered; both live function bodies exactly
  match the reviewed repair, with original ACLs/security/search_path retained.
  Production web deployment `7801559448` succeeded at 09:39:55 UTC. The first
  CLI migration-ledger repair hit temporary-role authentication error `28P01`;
  the existing timer's automatic retry succeeded without an ad hoc database
  write. Final catalog/pointer receipt and a human reload remain open.
  The owner's screenshot now
  corroborates the exact error in Manage place while it remains loading;
  [redacted evidence is on the repair](https://github.com/DonSquires/Field-Compliance-Manager-/pull/525#issuecomment-6892327877).
- [ ] **R05: officer gate/checkpoint capture.** Preserve and review
  `wt-officer-gate-capture`; verify geometry meaning, actor/tenant authority,
  provenance, retries and the actual officer entry path before release.
  Fresh live preflight at Atlas source `80e61fbb` confirms the proposed writer
  is absent, and no web/mobile caller exists. The preserved plan's separate
  Officer Places gate mode is not built. Its disposable PostgreSQL test reaches
  creation/history/replay, then fails on stale expected wording for the working
  missing-map guard. The draft also replaces the current history-read policy
  wholesale; reconcile it with current access rules before promotion. Source
  worktree remains untouched; source-corpus business values were not promoted.
- [ ] **R06: CRM client profile, PR #514.** Current CI passes and the PR is
  draft. Reconcile reported broader browser failures with the latest head;
  verify draft preservation, client/place context, findability and return path.
  Latest offline desktop/mobile run at `ca472dd9`: 50 passed, 12 failed.
  Ten failures still expect the old automatic account dialog; two encounter
  unsupported Windows screenshot baselines. Both new draft/return checks pass.
  Keep the PR draft pending related test reconciliation and visual acceptance.
- [ ] **R07: approved Workforce/timesheet slice.** The previous implementer
  disappeared without a report or code. Preserve the approved plan, reconcile
  #513 and VB-17 first, then implement settings, generation, staff replies and
  administrator review task by task. No payroll automation without saved rules.
- [ ] **R08: Vibe blocked-verification self-triage.** Preserve
  `wt-vibe-self-triage`. Recovered the bounded patch after finding six existing
  compatibility regressions in the abandoned implementation. Corrected module:
  169 passed, zero failed, two existing container-root permission skips.
  PR #517 passed all checks and merged as `3a760e61`. Its execution is resident
  in the control plane, not proved deployed by a Vercel receipt. Governed
  runtime deployment is now verified at `623981e9`: successful ledger receipt,
  restarted control plane, exact merged module hash and healthy HTTP endpoint
  at 08:44 UTC. Real blocked-browser-turn recovery remains unproven; retain
  this item for workflow acceptance rather than equating delivery with recovery.
- [ ] **R09: governed failed-turn recovery, PR #496.** Review the existing
  backend contract and UI retry receipt, lost-response behavior and eligibility;
  integrate with R08 without duplicating recovery writers.
- [ ] **R10: VB-14 in-app Bob.** Four changed files, open session, latest event
  is an error. Read final diagnostics/diff; recover useful work and validate
  multi-action behavior, simple chat UX, failures and explicit authorization.
- [ ] **R11: independent human-workflow UX review.** Review Client Data &
  Setup, Workforce and Finance as connected tasks, not a checklist of pages.
  Identify missing entry paths, duplicated concepts, context loss, dead ends,
  disconnected records and unnecessary navigation. Implement bounded,
  evidenced corrections; propose coherent designs before broad restructuring.
  Source-only six-finding review is complete; findings are recorded below.
  Browser/human checks and resulting corrections remain open.
- [ ] **R12: integration/release hygiene.** This isolated branch was advanced
  to reviewed PR #515 head `cf223456`; the main checkout now tracks released
  main, tracking `origin/main`, preserving its unrelated untracked files.
  Keep signed verified release identity and record deploy/migration receipts.

## P2: finish or explicitly retire other recent proposals

- [ ] **R13: PR #497, BB-163 correction rounds.** The job is cancelled; decide
  whether the job-specific implementation is still useful. Do not revive a
  cancelled job merely to justify its PR.
- [x] **R14: PR #495, Claude compatibility tests.** Reviewed the small synthetic
  regression against current routing: 18 existing tests and the added request
  assertions passed. Merged through the protected rebase lane as `5e008d83`.
  The original PR commit was verified; the rebase result preserves the required
  author but GitHub reports its signature as unsigned. Post-merge CI/deployment
  verification passed: all three verification jobs succeeded; production
  deployment `7800116376` reports success. This is deployment evidence, not a
  live restricted-data model qualification.
- [ ] **R15: PR #494, officer scan agreement recovery.** Verify current behavior,
  authorization and place/agreement context; finish or demonstrate supersession.
- [ ] **R16: PR #478, private VPS model fallback.** Reconcile with approved
  private-data qualification and current routing; availability is not permission
  to transfer restricted material.
- [ ] **R17: PR #475, isolated toolchain installs.** Verify current install
  capability and sandbox boundaries; retain useful work without bypassing gates.
- [ ] **R18: VB-16 / Atlas gaps.** Session is open with a last error. Recover
  its two changed test files, then remeasure live Atlas gaps. The old 331 count
  is historical, not the current backlog.
- [ ] **R19: classify remaining Atlas gaps.** Prioritize user-visible broken
  completion flows, then missing actions/readers, then dormant infrastructure.
  Record map false negatives, intentionally server-only entities and legacy
  nodes separately. Refresh generated edges after real code/schema changes.

## P3: preserve and disposition older work

- [x] **R20: PR #83**, Codespaces prebuild upload diagnosis. Closed: zero
  changed files, historical regional upload failure, no repository-controlled
  fix to merge. Evidence remains on the closed proposal.
- [ ] **R21: PR #12**, freedom-camping dispute portal.
- [ ] **R22: PR #11**, parking notice pipeline.
- [ ] **R23: PR #10**, zone/jurisdiction rules.
- [ ] **R24: PR #9**, smoke-control constraints and evidence.
- [ ] **R25: PR #8**, device/payroll/radio proposal.
- [ ] **R26: PR #7**, incident register and guard view.
- [ ] **R27: PR #6**, noise-control matrix.
- [ ] **R28: PR #5**, browser baselines.
- [ ] **R29: PR #4**, dispatch/pay-line resolution.
- [ ] **R30: PR #3**, control-plane host runtime.
- [ ] **R31: remaining worktrees.** Inventory the release-ready, dispatch-zone,
  Bob graph/history, graph, model-skills, builder-diagnostics, self-heal,
  worktree-hygiene and dispatch-parity trees. Compare local diffs and unique
  commits against current main before classifying. Never remove a dirty tree.
- [ ] **R32: Bob code graph.** Preserve the untracked graph module/tests and
  four integration edits in `wt-bob-code-graph`; establish useful capability
  and compatibility with current Builder before accepting any patch.
  Owner-requested untracked-file review confirms the module/test are absent
  from main. All nine preserved integration tests pass: source provenance,
  directed navigation, ambiguity, stale/missing snapshots and private-path
  filtering. Both existing worker-image manifest tests also pass. Current
  Builder compatibility and control-plane delivery remain unverified; do not
  bulk-copy the older integration files.
- [ ] **R33: Vibe history UI.** Preserve the substantial uncommitted history
  implementation/tests in `wt-bob-vibe-history`; review it separately from the
  smaller failed-turn recovery PR, including history findability and pagination.
  Its untracked browser test already has a newer counterpart on main from
  #469 (`0bc83b1c`), including reference search/rename coverage missing from the
  preserved version. Do not overwrite that newer test. The remaining tracked
  UI/CSS/unit-test/documentation edits still need independent reconciliation.
- [ ] **R34: patrol import/work classification.** The dispatch-zone preservation
  commit contains 31 changed files and historical schema changes. Recover by
  feature and current-schema comparison, not a bulk cherry-pick or snapshot
  overwrite.
- [ ] **R35: older governed Vibe continuation/recovery.** The release-ready
  branch has seven files of unique changes. Compare against current recovery
  writers and PR #496 before deciding which behavior is genuinely absent.

## UX review follow-ups

The independent review was a source walkthrough at `65f2fc1a`, not a deployed
human test. It found three deterministic control/state problems, one financial
meaning risk and two task-continuity hypotheses. Do not equate these categories.

- [ ] **R36 (P1): invoice handoff.** "Open invoices" routes to the money
  overview, not an invoice queue. Follow the generated draft into an existing
  authorized invoice view; verify the exact returned document and no implicit
  send. Reconcile CRM #514 before changing that destination.
- [x] **R37 (P1): false-clear completed-work billing state.** An initial query
  error can coexist with "Everything finished has been billed"; a refresh
  failure can leave stale rows. Also, ready-only queries cannot prove everything
  is billed. The bounded repair and regression tests preserve
  commercial blockers and distinguish unavailable, stale and successfully empty.
  Independent review also found stale organization responses could overwrite
  the current context and loading lacked announced busy semantics. The same
  bounded repair resolved both findings with deferred-response regression
  tests. PR #518: 33 focused tests and combined web build passed. Its first
  browser job reached the suite-wide 180-second limit without an assertion
  failure; the single failed-job retry passed. All required checks passed and
  the proposal merged as `e2273b64`. Production deployment `7800856224`
  succeeded at 08:31:45 UTC. No live invoice-generation or financial writes
  were used for acceptance.
- [ ] **R38 (P1): direct pay versus loaded service cost.** The actual-labour
  posting derives from pay, while wording does not explain the missing loaded
  cost boundary. Confirm the intended meaning with the owner before changing
  that design; do not invent on-cost rules or alter wage calculations.
- [ ] **R39 (P1, linked R06): client context integrity.** Main's selected client
  need not match its URL, and an unavailable requested client can fall back to
  another record. Retest against #514 before adding a duplicate fix.
- [ ] **R40 (P2): staff continuation.** Observe whether an administrator can
  continue from one employee's setup to their roster/hours queue without
  re-searching. Missing contextual links are source-confirmed; user harm and the
  best handoff need a human check.
- [ ] **R41 (P2): navigation vocabulary.** Test first clicks for adding a
  client's place, employee setup and finished-work billing on desktop/narrow
  layouts. Preserve specialist routes; change only labels/defaults/links shown
  to mislead rather than imposing another global page reshuffle.

## Deployment repair and acceptance

- [x] **R42 (P0): obsolete release identity guards.** The installed release
  lane, Builder publisher, catalog refresher and hook policy expected the
  obsolete noreply author, contradicting the owner's exact verified identity.
  Before: verified release commits exist on main. During: the installed
  service fails closed (`Result=exit-code`, status 1). After: the governed
  deployed pointer remains at `56745340`, despite later merged fixes.
  Correct the exact expected identity without relaxing mismatched-author
  rejection or signing. Verify all four consumers and bootstrap only the
  reviewed merged lane script; preserve active work and existing idle checks.
  Atlas has no matching capability nodes or direct edges for these three
  script/module names at source `0bf8d171`; flow/FK reach is therefore unknown,
  not zero. Schema has no matching names. Source proves the shared publication
  and deployment path. Do not hand-edit Atlas to imply a working deployment.
  PR #520 corrected all four exact-identity consumers without relaxing
  rejection, signing or protected-main requirements. All required checks
  passed; protected rebase merge `623981e9` completed at 08:37:26 UTC.
  The owner's separate approval covered exactly the two non-secret runtime
  author fields, which are now verified in the running container. The
  checksum-verified reviewed lane script was installed without a forced
  control-plane restart. Its first activity check failed safely; the existing
  timer retried and completed at `2026-11-15T08:44:28.861Z`.
  The governed deployed pointer and successful ledger both name `623981e9`;
  the restarted control plane's Vibe and publication module hashes match that
  merged source and HTTP health is `ok`. No migration was part of this release.
  Vercel deployment `7800922509` separately succeeded at 08:38:18 UTC.

## Recovery evidence

- Baseline: remote main `65f2fc1a`, successful GitHub-recorded production deploy
  after #513. No active Builder jobs; BB-191 is historically failed with
  autopilot marked done. VB-14/VB-16 are open with last error events.
- The current approved Workforce plan exists on its separate branch as
  documentation only; no implementation is credited.
- Main checkout was safely fast-forwarded to `65f2fc1a`; its unrelated untracked
  files were preserved.
- Patch-equivalence checks confirm builder-diagnostics and worktree-hygiene
  commits are already represented in main. Model-skills' two release-identity
  commits are also patch-equivalent; its untracked author-budget plan remains
  preserved. No worktree was deleted.
- Live Atlas at source `65f2fc1a` reports **229 present/unwired live entities**:
  116 columns, 69 RPCs, 43 tables and one edge function. Separately, 2,065
  present/unwired entities are marked legacy. The live non-column subtotal is
  113; neither that subtotal nor the combined count is directly comparable
  with the historical 331 without matching filters. This is classification
  evidence, not proof that 229 user-facing features are broken.
- A subsequent read at refreshed source `5e008d83` (20:32 NZDT) returned the
  same counts. Scoped preflights now contain some raw `exercised=true` map
  values, unlike the older entirely-unpopulated warning. These values still
  do not prove an invocation or successful task completion.
- VB-17 is now closed; its proposal and confirmed missing queue revision are
  tracked under R03. No VB-18 row was returned by the exact-reference lookup;
  keep the owner's report as an unresolved lead.
- Pending items above remain unchecked until their specific evidence is recorded.

## Untracked-file review requested by the owner

Read-only inventory covered all 17 registered Windows worktrees: **18 untracked
files across nine trees**. Untracked is a Git state, not a quality judgement.
No candidate was deleted or automatically committed by this inspection.

| Candidate | Files | Disposition / next action |
| --- | ---: | --- |
| Current recovery tree's queue and checkpoint migrations/tests | 4 | Queue repair delivered in #523; checkpoint repair merged in #525 and its live bodies/ledger verified. Their untracked state reflects this tree's older base, not missing publication. |
| Preserved checkpoint migration and two function definitions | 3 | Useful source for R04; recovered into the qualification-only forward repair. Preserve originals. |
| Officer gate migration, function definition and plan | 3 | Useful unfinished R05 work. No live writer or officer UI entry path; reconcile policy and complete executable coverage before promotion. |
| Bob code-graph module and test | 2 | Useful missing R32 capability; nine tests pass. Reconcile integration and packaging with current main. |
| Vibe history browser test | 1 | Older variant of the test delivered by #469; current main has additional reference/rename coverage. Preserve, but do not replace newer coverage. |
| Graph exclusion configuration | 1 | Supporting R32 configuration excluding sample corpus, dependencies, generated output, snapshots, schema snapshot and workflows. Review with the graph pipeline, not as app code. |
| Builder author-budget plan | 1 | Operational evidence. Read-only VPS verification confirms both staged and running base allocations are already 96; no restart or configuration write was performed. Other plan limits were not reverified here. |
| Automatic-timesheet/cost-allocation design | 1 | Useful historical draft, explicitly not the approved direction. Reconcile details with the approved three-area design and bounded Workforce plan; do not silently expand that slice into loaded-cost posting. |
| Main checkout's Edge debug and JASS configurations | 2 | Local editor/extension settings, not application repairs. Edge points to the extension start page; JASS targets Warcraft scripting files. Preserve untracked and do not publish as FCM defaults. |
