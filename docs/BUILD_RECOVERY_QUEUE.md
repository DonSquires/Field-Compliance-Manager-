# Build recovery queue

Updated: 2026-11-15. Owner: Don Squires. Coordinator: this recovery session.

This is the requested priority list for interrupted chats, unfinished branches,
Builder/Vibe work and task-completion gaps. It supplements, rather than replaces,
[the rebuild plan](REBUILD_PLAN.md). Every item needs a recorded disposition:
completed with evidence, superseded with proof, or blocked with a specific next
action. An open chat, green preview, merged PR or Atlas flag is not completion.

## Working rules

- Preserve uncommitted work. A crashed chat is not permission to discard its files.
- Leave VB-17 running. Recheck VB-18 after VB-17 finishes; do not assume one fixes
  the other or start duplicate work.
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

- [ ] **R03: VB-17 / VB-18.** VB-17 is active on timesheet UI; leave it alone,
  inspect its final diff/receipt, then check VB-18 separately. Accept only real
  persisted outcomes and error/recovery states. Neither is assumed resolved.
- [ ] **R04: location checkpoint reader.** Preserve and review
  `wt-checkpoint-map-fix`, including its migration, schema-function files and
  regression test. Establish whether the reader ambiguity reproduces, then
  finish or record why the existing patch is superseded.
- [ ] **R05: officer gate/checkpoint capture.** Preserve and review
  `wt-officer-gate-capture`; verify geometry meaning, actor/tenant authority,
  provenance, retries and the actual officer entry path before release.
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
  deployment is blocked by R42. Real browser recovery remains unproven.
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
  main `0bf8d171`, preserving its unrelated untracked files.
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
- [ ] **R33: Vibe history UI.** Preserve the substantial uncommitted history
  implementation/tests in `wt-bob-vibe-history`; review it separately from the
  smaller failed-turn recovery PR, including history findability and pagination.
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
- [ ] **R37 (P1): false-clear completed-work billing state.** An initial query
  error can coexist with "Everything finished has been billed"; a refresh
  failure can leave stale rows. Also, ready-only queries cannot prove everything
  is billed. Bounded repair and regression tests are in progress. Preserve
  commercial blockers and distinguish unavailable, stale and successfully empty.
  Independent review also found stale organization responses could overwrite
  the current context and loading lacked announced busy semantics. The same
  bounded repair resolved both findings with deferred-response regression
  tests. PR #518: 33 focused tests and combined web build pass. Its first
  browser job reached the suite-wide 180-second limit without an assertion
  failure; one failed-job retry is running. Do not merge while checks are red.
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

## Newly confirmed deployment blocker

- [ ] **R42 (P0): obsolete release identity guards.** The installed release
  lane, Builder publisher, catalog refresher and hook policy still expect the
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
- VB-17 was still active at the latest read. No VB-18 row was returned by the
  exact-reference lookup; keep the owner's report as an unresolved lead.
- Pending items above remain unchecked until their specific evidence is recorded.
