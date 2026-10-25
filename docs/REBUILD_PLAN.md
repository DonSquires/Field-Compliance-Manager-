# Rebuild Plan — bringing the build to the canon

Status: active. Owner: Don Squires. Order of authority: `docs/canon/README.md`.
This replaces the scattered per-topic TODOs as the top-level sequence; the
detailed backlogs (`ENTERPRISE_SAAS_TODO.md`, `PROTOTYPE_GAP_AUDIT.md`,
`MODULE_BASELINE_REQUIREMENTS.md`) hang off the workstreams below.

Completion language is strict, as in the lineage: **merged ≠ deployed ≠
glass-proven.** A workstream item is done only when its evidence gate is met.

Builder research release follow-up, 2026-10-25:

- PR #213 and generated-catalog PR #214 are merged; governed release
  `c6fc771cd9f2a6b0979f7211ac72cdb737292ac8` completed with healthy control
  plane, applied migration, matching live schema and refreshed Atlas.
- Production UI synthetic thread `c4d91a50-d586-42da-ae9a-101f36468359`
  completed with Kimi vision, private document extraction and matched official
  Docker source quotes. Persisted approval and receipt show history withheld,
  one raw image, no raw documents and three sources. No job was proposed.
- The subsequent fault-only private investigation failed: Compose rereads and
  model timeouts, no valid repair plan or job. Larger installed GPU candidates
  exceed the existing memory guard and were not loaded. A bounded eligible
  Qwen3 diagnostic still failed; its settings are not promoted.
- A prepared tool correction refuses invalid search paths instead of silently
  broadening scope and bounds source reads to 120 lines/8,000 characters.
  This improves evidence handling, not a claim of autonomous repair completion.
- Tool correction #216 deployed as `96127f4d123cc776c3e13916681cf1e15437bfa2`
  with green CI and healthy release. The next UI continuation still looped;
  a proposal was refused for missing ledger/Atlas evidence, then the model's
  ordinary reply was incorrectly recorded as a completed answer. No job card
  was accepted. A follow-up fix recognizes repair-plan requests per clause,
  distinguishes "do not create" from "do not propose", and keeps a rejected
  proposal attempt incomplete until a validated proposal actually succeeds.

Builder chat public research, owner decision 2026-10-25 (deployed and live UI verified):

- Before: local chat candidates could consume the entire wall budget before
  cloud was reached; chat had no image/document/public-web research input.
- During: add isolated, owner-approved public research with cloud candidates
  first, live availability/vision checks, owned attachment staging, private
  document extraction, bounded public search/fetch and source-quote validation.
  No previous history or repository packet leaves via this mode; normal source
  investigation remains private. Persist per-message approval and evidence.
- After gate: runtime, UI, migration authorization and browser tests must pass,
  then governed migration/release and live synthetic image/document/web checks
  must prove persisted receipts. This is not yet autonomous repair readiness;
  the missing API release source still requires Bob's own investigation/plan.
- Local evidence: runtime suite, web types/build/full unit suite, disposable
  PostgreSQL role/ownership/consent/replay checks and desktop/mobile synthetic
  document browser checks passed. A real public Docker-documentation request
  fell through invalid Kimi output to validated DeepSeek source quotes; a real
  Kimi vision request correctly read READY and three tasks from an
  offline-generated synthetic image. These were isolated adapter probes, not
  persisted production UI turns or proof that a live repair completed.

Builder chat investigation gate, owner correction 2026-10-25 (merged and deployed #212):

- Before: live UI research requests exhausted their model turns and produced
  actionable proposals copied from the owner's message, despite incomplete
  source investigation. One such job was created by the supervising engineer;
  the owner rejected this shortcut and that job was cancelled through the UI.
- During: remove automatic brief-to-proposal drafting. Require successful
  source-file, job-ledger and Atlas reads before accepting a model proposal,
  cite inspected source in the plan, and persist the research receipt. Failed
  reads, search matches and documentation alone do not satisfy source inspection.
  Structured JSON carries the same argument contracts as native tools.
  Repeated tool failures or empty searches advance the configured model chain
  with the existing evidence; they do not create a replacement job.
  A live follow-up also reproduced an empty reply rendered as "Done." and
  `list_dir(".")` rejected as unsafe. Empty replies now fail explicitly;
  root-directory discovery is allowed without relaxing file/write path guards.
  Add bounded tracked-path discovery (`find_files`) so chat can locate lifecycle
  files without confusing literal content search with filename search.
  Require model-authored source findings with quotes verified against actual
  reads, concrete repair steps and acceptance checks. Append these to the job
  description rather than accepting a job whose only plan is to investigate later.
- After: an incomplete investigation reports a failure and its missing checks,
  with no Create job card. Runtime guidance teaches literal search, source
  tracing, argument repair and the live-host access boundary. Synthetic tests
  must pass before release; successful live UI investigation and a model-authored
  plan remain required. This does not grant VPS shell access or claim the missing
  release has been restored.
- Private-model diagnostic: the changed modules were loaded in a separate VPS
  process with cloud routing disabled, read-only repository/Atlas/ledger tools
  and an in-memory chat store. No production modules were replaced and no job
  was created. The final test switched from qwen2.5-coder:7b to qwen3:8b after
  repeated reads, but did not complete a valid source-grounded plan. It correctly
  returned an explicit incomplete-investigation error without a proposal. This
  proves the refusal boundary, not autonomous repair readiness.
- Release evidence: merge `6768896ea698612878c3deb752a11f4ccb95084f`
  deployed through the governed control-plane lane. The subsequent live UI turn
  refused an incomplete proposal correctly but did not finish the investigation.

GitHub support automation, expanded owner decision 2026-10-24:

- The owner subsequently lifted the GitHub-specific restrictions and
  delegated supporting workflow selection. Vibe Builder and Bob Builder
  remain the primary builders. Remove the obsolete workflow-name allowlist;
  GitHub supports CI, review and build evidence rather than becoming a
  parallel builder. Additional governed workflows are permitted.
- Extend the existing credential-free verification to pushes to `main`,
  alongside PR and manual runs, so the integrated tree gets independent CI
  evidence too. Retain the PR integration boundary and verified release
  identity. Choose to keep the VPS as the single production migration writer;
  lifting GitHub restrictions does not require duplicating production writes.

- New `verify-pr.yml` uses no Supabase secrets, no persisted checkout credential
  and read-only contents permission. Three independent jobs run runtime and
  migration-inventory checks, web types/build/unit tests, and offline browser
  harness/navigation plus the existing operational smoke suite.
- The initial owner decision retained the VPS as the sole production migration
  writer; that remains the selected topology. GitHub Supabase secret names
  were confirmed, but no live database,
  embedding or deployment job is enabled by this workflow. Production
  environment protections and scoped credentials must be designed before
  implementing credentialed Actions jobs.
- Existing product/test mismatches are expected to remain visible in CI;
  there is no skip or continue-on-error to make the Overview redesign green.
- First Actions run `40071970872`: types/build passed; web tests passed 1,791
  with the existing Overview 48px-header guard failing. Operational browser
  checks passed 15/16, failing the existing Overview screenshot. The six
  harness/navigation checks completed, with one staff-navigation retry.
  Runtime passed 1,554 with 13 skipped and one obsolete no-Actions guard
  failing. The initial correction allowed exactly `verify-pr.yml`; the
  expanded owner decision now removes that allowlist entirely. The separate
  verification-workflow contract retains its no-secret/read-only/no-release
  boundary without forbidding additional workflows.
- Corrected run `40072496447`: runtime passed 1,555 with 13 skipped; browser
  harness/navigation passed 6/6 without retries. Only the existing Overview
  unit guard and screenshot remain red (373/374 unit files, 15/16 smoke tests).

Independent Bob Builder chat lane, owner ruling 2026-10-25:

- The Builder page chat no longer mounts `BobPanel mode="builder"` (which sent
  turns to `onspace-ai-chat`). `BuilderChatPanel` uses migration
  `20261025090000_builder_chat_lane.sql` (owner-only RPCs, Realtime) and the
  control-plane `builder-chat-session.js` worker (builder model chain via the
  gateway's `builder_chat` mode, read-only tools, `propose_job`).
- Proposals become jobs only on the owner's Create job click (shows project,
  branch, environment, review mode and autopilot before confirming).
- `onspace-ai-chat` returns 409 `builder_lane_separate` for builder turns;
  `scripts/bob-builder-e2e.mjs chat` drives the new lane by default.
- Runtime-idle defers control-plane deploys while a Builder chat turn is
  claimed.

Builder lane separation hardening, 2026-10-24:

- Enforce lane boundaries in the Conductor: Builder-only tools
  (`dispatch_flow`, `create_builder_job`, `cancel_builder_job`,
  `laptop_shell`, `run_human_test`) are filtered from operations-mode
  catalogues and blocked server-side if selected outside Builder mode.
- Preserve in-app operations workflow: users can still converse with Bob for
  operational read/reasoning/proposal work; build execution stays in Bob
  Builder mode/lane.
- Prevent release interruptions of active Vibe work: runtime-idle checks now
  include pending/claimed `builder_vibe_messages`, so control-plane deploys
  defer while Vibe turns are in flight.

Vibe verification repair (vibe-v14), 2026-10-24:

- Before: recent shipped session `b237fe39` tried to load Playwright through
  Vitest, replaced typed Playwright imports with `any`, and added no-op
  placeholder comments while repairing syntax repeatedly. Current main
  reproduced 24 implicit-any TypeScript errors. The tool loop also counted
  each lint rerun toward the identical-call ceiling even after a real repair.
  Ship as PR published without a fresh check despite failed receipts.
- During: restore static typed imports and exclude `e2e/**` from Vitest
  discovery (Playwright still discovers those tests). Reject the wrong
  Vitest/e2e command with a specific correction. Reset verification-call
  repetition counts only after a successful edit actually changes source;
  no-op/failed edits and unchanged retry loops do not reset them.
  The read-only action policy explicitly guards suspend/restore/reactivate
  and related lifecycle controls; labelled data is tested only through
  targeted, governed scenarios. Restore Atlas's explicit boolean gap-report
  arguments and the existing Overview screenshot identity: passing raw
  request values and renaming a missing snapshot were not valid repairs.
  Register `human_test` before generating the model's JSON/native tool
  definitions (it previously existed only in the dispatcher). A successful
  browser run supersedes a misrouted Vitest/e2e attempt without ignoring an
  unrelated genuine failed check.
  Browser inputs now include harness/config files and directly edited
  Playwright specs; a fully skipped walk or error findings cannot certify
  success. Fresh pre-publication lint, changed root test/syntax checks,
  unresolved recorded checks and applicable browser verification must pass
  against the unchanged branch head before any push/PR creation. Each
  check posts a receipt bound to that head. Unavailable browser verification
  blocks publication; this is stricter than the older non-blocking
  infrastructure report at conversational handoff.
- Training: runtime instructions and the enterprise UX training explain
  before/during/after workflow assertions, selected state, Back/Forward,
  persistence, downstream effects and lifecycle tests. Text uses `Bob Test`,
  numbers use `999`, dates are scenario-chosen; constrained fixture values
  need a recorded exception. Test prefixes alone never authorise a write or
  identify an existing record as safe to archive/suspend.
- Evidence scope: Atlas reads confirm Vibe session/message/attachment
  read/write edges and the claim RPC. Component downstream flow is distinct
  from the empty component FK reach; exercised is still null. Synthetic
  model probes and current model-role recommendations are recorded in
  [the private compute assessment](BOB_PRIVATE_COMPUTE_ASSESSMENT.md).
  Training is not proof that generic walks now test all workflows.
  Validation: the final bounded root suite passed 1,559 with 8 skipped
  (unbounded concurrency first caused a transient
  control-plane startup timeout; its isolated 23-test suite passed too).
  TypeScript and 373/374 web unit files passed; one existing Overview CSS
  guard still expects the old 48px header instead of the redesigned 52px.
  Five focused browser checks passed, and 4/5 Overview/dispatch checks passed:
  its existing screenshot differs by 70%. No screenshot, tolerance, CSS
  guard assertion or product design is silently changed to bless that output.
  Dr Bob still warns about 27 unreadable Overview text elements. Those
  product/visual findings remain open for Bob's governed redesign workflow.
- Release diagnosis: the public Vercel build was `a68d76d0`, while the VPS
  release marker remained `6f4a7913`. Live read-only catalog/ledger inspection
  confirmed `20241022120000` was not applied: it guessed four RPC signatures
  and attempted unjustified anonymous/authenticated maintenance grants.
  Preserve that unapplied migration identity as a no-op; do not implement
  those grants. The release host also reproduced a missing Linux CLI binary
  from unpinned `npx supabase`. Explicitly selecting the locked CLI 2.115.0
  and its matching native package passed `--version` on the host; both
  deploy and ledger repair now use that locked helper. No unmerged
  migration, function deployment or runtime restart was performed.

Vibe browser verification with Dr Bob's walk (vibe-v13), 2026-10-22:

- Before: Vibe accepted a handoff after the TypeScript check alone. The live
  preview was for the owner; nothing walked the changed UI in a browser, so
  console errors, broken routes and UX/layout findings reached the owner
  first. Bob Builder's `frontend-verify` already ran lint, build, unit tests
  and smoke plus targeted e2e specs, but Vibe had no browser evidence.
- During: when a message changed browser-visible web files
  (`apps/web/src/`, `index.html`, `public/`) and the other checks passed,
  Vibe runs `e2e/dr-bob-human-test.spec.ts` plus the targeted specs for
  those files in the `vibe-human-qa` worker. That worker is offline
  (`--network=none`, `E2E_OFFLINE=1`, `HUMAN_TEST_LIVE=false`), mounts the
  source read-only and receives no credentials. It runs on desktop Chromium
  only and one walk at a time. Bob can also call `human_test` himself. Two
  outcomes block the handoff once, so Bob can either fix the problem or
  give a `blocked_reason`: a failed spec (including a screenshot mismatch)
  or a Dr Bob error finding. If the worker cannot run, that is reported but
  does not block. Unchanged UI files are not walked twice, and walk time
  does not count against Bob's working budget. Every reply ends with the
  walk's counts, and the report and screenshots stay under
  `.human-test-runs/`. This is fixture evidence, not a live-tenant test or
  merge approval.
  `BOB_VIBE_HUMAN_TEST=0` turns the walk off; `BOB_VIBE_HUMAN_TEST_TIMEOUT_MS`
  bounds it (default 20 minutes; the desktop walk took 6.5 minutes locally).
  The first real walk of `main` found a defect in the walk itself: in the
  field-portal step, `/schedule/` matched the disabled "Start unscheduled
  shift" button, which timed out every run. The walk now selects only enabled
  controls whose text matches a whole word.
- First owner-requested walk (session 6d6438f8, 2026-10-22): timed out at 20
  minutes with no readable report. The trace showed the harness, not the page:
  after "Pick position on map" on `/admin/sites`, the page rendered fewer
  buttons and an unbounded `textContent()` on button #17 waited out the
  15-minute test timeout (2 of 3 VPS runs). The runner's label reads now have
  1-second bounds, and Playwright's 18-minute `--global-timeout` ends the run
  before the 20-minute host kill, so a slow walk still yields a report. Vibe
  branches do not yet pick up later main commits, so an older session keeps
  its own copy of the harness until it is shipped or rebased.
- Dr Bob's UX audit now checks text contrast: visible text below 3:1 against
  its first opaque ancestor background is a warning that names sample text.
  The verified walk of session 6d6438f8 passed while its headings were dark
  blue on navy. Before this check the audit measured font size but not colour.
  With the check, Bob's CSS raises 27 faint elements ("Today at a glance",
  "Priority queue", …); main raises 4 warnings on genuinely faint helper text.
- Bob Builder parity (checked against the live jobs ledger): Builder is
  progressing jobs; two were deployed on 2026-10-21. It shares the XML
  tool-call parser and the whitespace-tolerant edits. It has its own guards
  that escalate on unparseable output, refusal loops and exploration
  without edits. The cross-lane "resides outside the allowed lane" failure
  from job 437257cb is re-scoped by #163. Builder does not yet run Dr Bob's
  walk; its browser evidence is still the smoke and targeted e2e specs.
- After: unit and root suites pass. Not yet proven: a real owner Vibe turn
  that ends with a walk receipt.

Vibe tolerant edits and Ollama Cloud escalation (vibe-v12), 2026-10-22:

- Before: owner session 6d6438f8 ("Overview & approvals" redesign) found the
  right `AdminHubPage.css`, but local models reflowed whitespace in its long
  one-line rules. Every `replace_in_file` was refused as a whitespace miss,
  the identical-call guard stopped the turn, and local recovery hit the same
  wall. No file changed.
- During: `replace_in_file` now accepts a unique match that differs only in
  whitespace or copied read_file `N: ` prefixes and reports `matched`;
  ambiguous normalized matches are refused. Under the owner's 2026-10-22
  ruling, Vibe may escalate to Ollama Cloud after private candidates, behind
  `BOB_VIBE_ALLOW_OLLAMA_CLOUD`, in JSON mode, never for attachment-bearing
  turns, with an `external_egress` status receipt (see
  [credential boundaries](BOB_CREDENTIAL_BOUNDARIES.md)).
- After: unit and root suites pass. Not yet proven: the owner's own retry
  producing the redesign; it remains unverified until Bob's turn succeeds.
- Owner retry (seq 399-403): coder 7B again skipped native calls; that
  refusal counted toward the prose limit, so the next prose line ("I'll
  continue...") was handed off with no tool run, and the session's earlier
  screenshot kept it local-only. Fix: protocol refusals are counted
  separately; prose without an executed tool is never a handoff unless the
  owner asked a question, and after a correction escalates once to the
  stronger candidate (Ollama Cloud when enabled); earlier attachment analysis
  is withheld from the cloud packet instead of blocking escalation; a
  missing native call keeps that model in JSON mode for six hours.
- Second retry (seq 404-408): in JSON mode the model sent the same promise
  as a formal `reply` call, which bypassed the prose guard. A reply before
  any tool runs is now refused once (unless it asks the owner a question or
  gives `blocked_reason`) and escalates to the stronger candidate.
- Third retry (seq 409+): escalation worked (coder 7B -> gpt-oss:120b ->
  deepseek-v4-pro), which read `AdminHubPage.css`, but then emitted its native
  `<tool_call name=...><parameter ...>` XML markup, which was shown to the
  owner as a reply. The parser now executes that markup and the
  `{name, arguments}` shape; unparsed tool markup is never handed off.

Vibe native execution and private compute, 2026-10-22:

- Before: Vibe made local models print JSON as text instead of using their
  declared native tool support. Invalid arguments and semantic-search loops
  consumed the turn; larger CPU inference was slow and no replay established
  autonomous UX acceptance.
- During: private Vibe requests supply function definitions. The gateway
  verifies the installed model's `/api/show` capability before using native
  assistant/tool messages, then normalises a single returned function into
  the existing guarded dispatcher. Transcript storage/compaction stays in its
  existing bounded format. Multiple returned calls are explicitly refused
  before execution and receive bounded correction. Models declaring no tool
  support use visibly reported JSON compatibility. A private replay proved
  declared capability alone insufficient: coder 7B returned text instead of
  native functions and described an edit it never executed. Such native
  responses are now refused without execution, visibly recorded, and retried
  through existing structured JSON for five minutes on that same private
  model. An unavailable capability probe fails explicitly instead of claiming
  either mode works. Tool schemas count toward context limits.
  Health/capability evidence is endpoint-scoped.
- After: all path, command, local-routing, repetition and runtime verification
  gates remain in force. A continuation test preserves a failing draft and
  exact check receipt, repairs the same branch, and requires a fresh pass.
  Mocked tests are not proof that arbitrary real redesigns self-heal.
- Private acceptance: Qwen3 8B returned eleven actual native function calls
  across two diagnostic turns (raw returned arrays checked, not just declared
  capabilities). On continuation it read the preserved TS2322 receipt, read
  the source, removed an intentionally injected invalid export, ran the real
  web lint command, and replied. Runtime and independent TypeScript checks
  passed. The preceding seven-step heading probe did not find the requested
  literal in the selected file and made no successful edit; it is not a
  successful redesign or heading-change receipt.
- Default-model acceptance: coder 7B returned no native function, was refused
  with `executed:false`, and then used five structured-JSON calls on the same
  private endpoint. An incorrect first literal edit was refused; a source
  search supplied the real text, the next edit removed the seeded fault, and
  model-invoked, automatic and independent lint all passed. No hosted model
  received the turn. All diagnostic worktrees were removed.
- Root regression suite: 1,528 passed, eight skipped. Diagnostic clones are
  disposable; no draft or owner turn is inserted into the original session.
  No migration or generated schema edit is required.
- [Private compute assessment](BOB_PRIVATE_COMPUTE_ASSESSMENT.md) separates
  measured machine limits, official model/vendor facts, illustrative costs,
  privacy prerequisites and acceptance before routing changes. No purchase,
  provisioning, endpoint or default model change is included.

Vibe typed edit contracts, 2026-10-22:

- Before: a disposable GPU replay using the installed, memory-eligible
  `qwen3:8b` found the owning page but supplied invalid replacement text,
  then asked the owner to provide code. The v9 output schema constrained
  the tool name but left its arguments as an arbitrary object.
- During: the output schema now has self-contained alternatives for write,
  replace, patch, delete, command and visual-baseline calls. Each requires
  the existing tool's exact argument names and value types; edit tools
  cannot fall through to the generic read/reply alternative. Empty
  replacement text remains valid (deleting matched text is intentional),
  while paths and old text must be non-empty. Existing runtime validation,
  path protection and command policies remain authoritative.
- After: a real private Ollama request accepted the schema and returned a
  complete, correctly typed replacement call. This proves decoder/schema
  compatibility, not that arbitrary generated code is correct. Vibe is
  instructed to repair its own tool calls rather than ask the owner for
  code, and to read the enterprise UX standard and existing CSS for UI work.
- The same replay also exposed semantic phrases sent to a literal grep
  tool. Vibe now explains that search matches case-sensitive source text,
  and an empty search includes a specific non-error hint to read/outline
  the known path rather than repeatedly append words such as "layout".
- Validation: the full suite passed 1,516 with eight skips. An earlier run
  passed 70 focused schema/gateway/Vibe/firewall/baseline tests.
  The first full run
  hit an existing binary-patch/index mismatch in the visual-baseline test;
  that test passed unchanged in the focused run and the complete rerun.
  No baseline or patch-transport code was changed.
- Separate capacity evidence: the private 30B CPU replay took 624 seconds,
  made nine model requests (four timed out), executed five discovery tools,
  and changed no files. The v9 alternate GPU replay completed nine requests
  in 209 seconds, but its invalid tool call and code-request handoff were not
  autonomous acceptance. Both disposable worktrees were removed. No default
  model routing or private-code egress policy was changed.

Vibe TypeScript handoff gate, 2026-10-22:

- Before: the v8 loop reports checks the model actually ran, but an author
  can omit lint entirely or cite a pass from before its final edit. Real
  local-model replays showed that a plausible edit is not compile evidence.
- During: before a reply or step-budget handoff, the runtime checks whether
  the branch/current worktree changes web TypeScript. It runs the existing
  `npm run lint --prefix apps/web` itself, through the same bounded tool
  runner, and writes an automatic test receipt with the message ID and a
  changed-file content fingerprint. No new command permission or dependency
  is introduced. Unchanged drafts reuse that receipt; a subsequent edit
  requires a fresh check. Failed checks enter the existing correction path
  so Bob can repair and recheck, or clearly report an unverified draft.
- After: the runtime, not the model's prose, determines whether the latest
  TypeScript draft passed this check. Sessions with no web TypeScript changes
  do not run lint.
  Failure still preserves the branch for inspection/undo; passing lint does
  not prove UX acceptance, browser behavior, schema correctness or deployment.
  This change does not enqueue a turn as the owner or bypass the owner-only
  continuation RPC.
- Validation: 41 focused Vibe/firewall/training tests passed; the full root
  suite passed 1,514 tests with eight skips. Regressions run a real fixture
  verification command and cover omitted checks, stale passes, a repair
  followed by a fresh check, failed-check receipt reuse, and budget exhaustion.
  They do not stand in for an autonomous redesign or a human browser test.

Vibe grounded discovery and local recovery, 2026-10-22:

- Before: live session `6d6438f8` searched an invented
  `LandingPageOverview.tsx`, ignored real files in a directory listing, then
  stopped on repeated listings without an edit. The author was the local
  7B coder. Existing continuation history was reaching the loop; more history
  alone did not solve discovery. Dependency hydration also removed a tracked
  `node_modules/.gitkeep`, incorrectly attributed to a protected model edit.
- During: Vibe reuses governed Builder's tracked-file discovery and Atlas
  flow-map helpers before the first model request, excluding generic session
  titles from discovery and including bounded source outlines. Candidates
  are evidence, not an approved diagnosis. Tool output is schema-constrained.
  Repeated unchanged read-only results are reused. A fourth identical call
  is refused; one distinct healthy, installed, memory-eligible local model
  may recover the turn. A second loop still stops; failed edits/commands do
  not reset the guard. Already-successful identical edits are not replayed
  without an intervening workspace change. Recovery receives the current
  diff and failed-check output. Failed verification blocks a successful
  handoff until the same check passes (unrelated passing checks do not clear
  it); known failures in bounded continuation receipts remain blocked too.
  The same source-guard selection may rerun in its required Node environment
  instead of jsdom, without modifying assertions. A blocked draft remains
  visibly unverified. No hosted provider is
  added. Known dependency noise
  is restored immediately after trusted workspace preparation, before model
  execution; actual model edits still pass the unchanged protected-path gate.
- After: regressions cover real-label discovery, local recovery, duplicate
  model exclusion, failed-edit loop bounds, and dependency housekeeping.
  The exact owner request now discovers `AdminShell.tsx`, `AdminHubPage.tsx`
  and other real candidates instead of inventing a page filename. This does
  not itself prove a correct redesign or live acceptance. Existing session
  drafts, screenshot analysis and protected release decisions remain intact.
- Matching chat training is additive in
  `20261023001000_bob_vibe_grounded_discovery_card.sql`; Vibe receives the
  discovery rules in its runtime prompt, not automatic card retrieval.
- Validation: root tests passed (1,510, eight skipped). The existing
  `AdminHubPage` source guards passed nine cases with `--environment node`.
  Two isolated real-model replays found real files and made edits, but did
  not complete the redesign: the first produced malformed TypeScript; the
  second failed a source guard under jsdom and correctly ended unverified.
  Those disposable drafts were removed; neither was published or copied
  into the owner's session. Passing recovery unit tests is not autonomous
  design acceptance.

Staff profile preview navigation, 2026-10-22:

- Before: an authorised HR user opens a staff row from the staff directory.
  Five checks traced the action URL, React routes, hosting responses, live
  Atlas/schema, and workflow/browser coverage. Production deep links returned
  HTTP 200; the same root-level link on Bob's preview host returned HTTP 404.
  Native popout URLs discarded the preview's `/vibe/<session>/` prefix, and
  BrowserRouter did not declare the Vite base. This was a transport/routing
  failure before staff reads, not evidence of missing staff records or RLS.
- During: BrowserRouter uses Vite's base; staff, evidence-record and return
  links use router-resolved hrefs. Production `/` behavior and existing
  caller-authenticated reads remain unchanged. Atlas confirms profile reads
  of `staff_profiles`, `user_profiles` and evidence tables; FK adjacency is
  structural only, not proof of additional flows. No schema change is needed.
- After: regression coverage follows the selected staff ID into the popout,
  changes tabs, reloads, opens a credential detail, returns to the directory,
  and verifies unavailable staff produces the existing permission/data state.
  Run at both `/` and a session-prefixed Vite base on desktop and mobile.
  These fixture-backed tests do not claim live tenant acceptance.
- Separate Bob receipt: both screenshot descriptions were saved before the
  coding loop stopped on four identical `routes` searches. The UI now
  distinguishes that partial completion from attachment processing failure.
  Bob receives verified route/Atlas naming guidance and a repeated-call
  recovery hint; the hard loop limit remains in place.
- Continuations now include previous Bob error replies as well as owner
  answers, and up to 60 recent execution/diff receipts rather than 12.
  The handoff names exact tool arguments, success/failure, committed files
  and bounded result previews. Nonzero command exits are recorded as failures,
  not successful tool dispatches. This is bounded history, not perfect memory
  of every earlier result; Bob must verify the current branch/diff before
  trusting an old change or reusing a stale test result.
- Matching platform knowledge cards are seeded by
  `20261022223000_bob_vibe_continuation_navigation_cards.sql` for Bob chat's
  existing retrieval path. Vibe receives the same operational rules directly
  in its runtime prompt; do not claim Vibe automatically retrieves these cards.
- Validation: eight focused browser cases passed across root/session-prefixed
  bases and desktop/mobile; 88 focused web tests, lint/type checks and build
  passed; root tests passed (1,495, eight skipped) before the card test was
  added. The broader HR suite passed 35 cases and failed five visual-baseline
  comparisons/missing-baseline checks. Baselines were not changed or waived;
  no live tenant acceptance is claimed.

Vibe Builder attachments, 2026-10-22:

- Before: Vibe messages were text-only. Bob chat stored files in the private
  `bob-uploads` bucket and had separate document/image processing paths, but
  Vibe had no attachment-to-session relationship. Atlas had no Vibe attachment
  capability or data-flow edge; the live schema made `bob_attachments`
  conversation-scoped and required `conversation_id`.
- During: the additive attachment migration defines a Vibe-session-scoped
  receipt with owner-only reads and RPC-gated registration/removal. The browser
  accepts selected JPEG/PNG/WebP and PDF/DOCX/TXT/CSV/XLSX files, uploads only
  under the owner's `desktop/{user_id}/vibe/{session_id}/` path, and links them
  to a message by checked attachment IDs. Documents use the existing text
  extractor without business-record registration; image bytes go only to the
  configured private Ollama vision model, with public endpoints and hosted
  fallback refused. The worker saves bounded, provenance-linked advisory
  context on the owner message; embedded file instructions remain untrusted.
- After: the model receives the selected document text and local visual
  description as context for that turn and later session history. This remains
  a Vibe-session record, not a tenant/business record. The migration is not live
  until the protected PR release lane applies it; Atlas should be refreshed
  after that and wired/exercised claims must wait for their own evidence.
- Release verification: #165 applied the migration; #166 regenerated the live
  schema and database types. The release lane completed at `57520d4f`, including
  the control plane and Atlas refresh. Live catalog checks confirmed RLS,
  denied anonymous reads/RPC execution, and denied direct authenticated inserts.
  The private VPS has `moondream:latest` installed. A repository screenshot
  revealed that its original multi-sentence prompt repeatedly returned empty
  output; a concise visual question returned a description. Vibe uses that
  tested question, retaining its authoring-level untrusted/advisory boundary.
  The description also contained inaccuracies and repetition: this proves local
  inference, not reliable visual diagnosis or a full browser-upload acceptance
  test. Human/source verification remains required.

Bob main-health visual baseline, 2026-10-21:

- Before: the geofence house-map full-page baseline predated the admin-shell
  redesign, location hazard register and three-boundary fixture. The current
  functional assertions passed, but the obsolete image differed by 20%.
- During: regenerated only the desktop geofence baseline with Playwright in
  the worker image. No screenshot tolerance or functional assertion changed.
  The verifier now compares screenshots instead of using
  `--ignore-snapshots`, so visual failures cannot pass verification and then
  repeatedly fail main-health.
- After: the read-only main-health worker passed root tests (1,467 passed,
  eight skipped), lint, build, Vitest and all 16 browser-smoke tests. A
  separate Dr Bob read-only walkthrough passed across 27 admin route
  families, including Locations and Zones. These are fixture-backed browser
  receipts, not proof of live tenant configuration.
- The fixture screenshot contains a missing brand image and unavailable
  service-place context; neither is evidence of a new production defect.
  They remain observations, not unconfirmed issues or unrelated UI changes.
- Baseline replacement here is an owner-authorized maintenance operation.
  Owner continuation, 2026-10-21: the dedicated `generate_visual_baselines`
  lane now prepares fixture-only PNG candidates, preserving before/after
  evidence and requiring independent rerendering. Generic arbitrary binary
  editing remains refused. Publication uses the existing verified branch/PR
  path and release holds; human review/merge is mandatory, never silent
  baseline acceptance to turn a failing test green.
- Historical failed/cancelled main-health jobs can be resolved only after a
  newer pinned main passes every health step and the original test files
  remain present at that commit. Resolution is organization/project scoped,
  refuses active execution or workspaces, records the verification and audit
  event, and marks automation done without rewriting the original status,
  error, approvals, artifacts or release history. Jobs without this proof
  stay unresolved.

Vehicle search pop-out window, 2026-10-20:

- Owner asked for vehicle search in a movable window for a second screen.
  It reuses the existing `popout=1` chrome-free shell pattern (CCTV wall, staff
  profile): one named window, same session/working organisation and route
  gating, opener cut after open. Evidence: page tests, web build,
  `e2e/vehicle-search-popout.spec.ts`. No schema or Atlas data-path change.
- Result rows show the shared profile photo thumbnail: one caller-RLS read of
  `vehicle_profile_photos` and one batch of signed URLs per result list,
  best-effort (a failure leaves the list intact). Page tests cover both cases.
- Selected vehicle: identity, flag action and warrant status are combined
  into the `VehicleProfile` card; observation history is a table (latest 50)
  with thumbnails signed from the private `scans` bucket, gated by the existing
  `scans_select` org-folder policy (live: 12 photo observations, all in
  `scans`). Evidence: page/profile tests and the vehicle e2e (desktop+mobile).

CRM embedded delivery workspace, 2026-10-20:

- The CRM account workspace embeds the per-site Client Setup view with the
  selected client and operating provider context. Schedule and billing changes
  remain explicit drafts, with per-row receipts and no fabricated CCTV/static
  coverage. As-attended Patrol uses the existing `manage_crm_as_attended_patrol`
  RPC and requires an active route; unavailable route reads remain visible and
  block the write. Existing schedules read their `work_model` and route
  configuration from the schema-backed records. No schema change or migration.
  Evidence: Client Setup attendance unit tests, CRM/AdminShell guard tests,
  Client Setup and AdminShell desktop/mobile e2e, TypeScript and production
  build.

CCTV photo enhancement, 2026-10-20:

- Human reported the console's Auto enhancement "not working" on a zoomed
  vehicle frame. Live read: the frame at 17:42:58 NZT on 18 Oct was a PNG
  photo, and `CCTVPlayerTile` had excluded photos from enhancement since
  19c7acac4 while still showing Auto as active. Photos now use the same
  display-only GPU/CSS pipeline as video (natural image size, redraw on load
  and on inspection change). Evidence: guard test, CCTV unit suite (145),
  web build, and `e2e/cctv-photo-enhancement.spec.ts`, which fails on the old
  exclusion and passes with the fix. No schema or Atlas edge change.

Owner-requested search and subject-trend refinement, 2026-10-19:

- Human confirmed selected-vehicle history now works after #125 and requested
  audited detail editing, a profile photo, and return-to-results navigation.
  Owner chose a shared photo across authorised organisations and editing of
  appearance plus registration/WoF/CoF expiry dates. The administrator's
  job is to correct the canonical vehicle with source/reason, then continue
  reviewing search results; this is not a new identity or owner-check workflow.
  Before: canonical public projection and registry writer exist, but Search
  has no editor or designated profile-photo store. During: a narrow details
  RPC delegates to `manage_identity_vehicle`, preserving org notes and shared
  fact review; patrol observations now participate in that writer's related
  and shared checks, matching the existing registry reader. Explicit expiry
  edits update their derived status. A private image bucket and caller-RLS
  profile-photo receipt use existing organisation custody/visible observation
  access, not Tier-0 public registry access. No raw external URL or public
  bucket is introduced. Images are human-selected, previewed, re-encoded to
  strip embedded GPS metadata, hashed and uploaded without overwrite.
  After: canonical detail refresh, audit receipts, signed photo display and
  return to the preserved result pattern/list. Failed writes remain errors;
  linking retry reuses a staged upload. Replaced image objects remain retained
  with previous paths/hashes in audit, not silently deleted or promoted into
  enforcement evidence. The client-provided hash is an upload receipt, not an
  independent server-verified evidence-integrity claim.
  Owner approved live application and protected publication. Catalog/storage
  readback confirms private 5 MB bucket, caller-RLS photo table, authenticated
  read without direct writes, no anonymous photo RPC, and scoped storage
  insert/select policies. The regenerated public schema includes the two new
  RPCs and profile table; storage policy/bucket definitions remain in the
  migration because the public-only catalog snapshot excludes storage.
  Atlas refresh registers 11 capabilities and 21 edges (presence/wiring, not
  human exercise). Validation: 19 focused identity/profile/history/database
  regressions, 37 Atlas generator tests, 29 UI/helper tests, four desktop/mobile
  browser cases, TypeScript and production build pass. Browser tests prepare
  a real synthetic image, save details/photo through fixture-backed APIs and
  restore the original search without another RPC. No live tenant photo or
  vehicle fact was changed for testing; signed-in human acceptance remains.
- Human confirmed registry wildcard search works after #124, but selecting a
  registration fails. Bounded production logs identify the observation-history
  GET returning HTTP 500 at 23:34:52 and 23:36:02 UTC, followed by eight-second
  statement timeouts. Before: discovery resolves an exact canonical identity.
  During: the shared history filter combines canonical UUID equality with
  exact plate `ILIKE`, forcing a sequential scan and unrelated per-row RLS
  work. After: the generic detail catch concealed the source as "Failed to
  search vehicle"; no usable detail/flag surface was shown.
  The repair adds a generated `observations.plate_number_upper` key and index,
  then uses indexed equality in the existing shared history helper. This
  preserves case-insensitive legacy matches, canonical links across old plate
  text, result limits, ordering, caller RLS and officer agreement-zone scope.
  It does not change source plate text, identity, access policy or permissions.
  The derived field follows inserts/updates automatically. Existing
  `canonical_vehicle_id` index remains in use. Atlas identifies both admin
  Vehicle Search and Officer Vehicle Lookup as callers of this shared path.
  Error handling now names failed detail sections and identifies history
  timeouts instead of hiding plain-object PostgREST errors.
  The isolated database fixture reproduces the old filter's unrelated-access
  evaluation, then verifies the new filter over 8,100 unrelated records,
  mixed-case legacy rows, canonical historical plates, denied records,
  agreement-zone filtering, deduplication, sorting and generated-key updates
  under a two-second statement limit.
  Owner approved live application and protected publication. Live catalog
  readback confirms the stored generated key; no-user-context authenticated
  EXPLAIN ANALYZE for both human-selected registrations, including the zone
  join, uses bitmap index scans on canonical identity and the new plate key
  (15.1 ms and 7.9 ms). No observation sequential scan remains in those plans.
  This is plan verification, not affected-user acceptance. Database regression
  and canonical-link guards, 24 focused UI/helper tests, four desktop/mobile
  browser cases, TypeScript and production build pass. Atlas refreshed.
- Whole-system follow-up, 2026-10-19: the policy short-circuit did not resolve
  the human's search timeout. Wider Atlas/schema tracing established that
  `resolve_record_canonical_identity` already calls `ensure_canonical_vehicle`
  for observation writes, and `canonical_vehicle_public` is the existing Tier-0
  discovery surface. Aggregate live verification found 8,095 plated observations
  and only 13 with no canonical identity/registry entry. Search now uses the
  registry plus caller-RLS fallback only for legacy unlinked observations, with
  a partial index on that subset. No new access engine, definer search, identity
  promotion, Conductor routing, or Oracle permission decision is introduced.
  Conductor owns Bob's dispatch/egress; Oracle describes truth state; neither
  is the UI search's permission engine. The existing batch access resolver is
  present but has no registered Atlas callers; it is not necessary for Tier-0
  registry discovery. The previous all-authorised, cheap-helper performance
  fixture missed the costly unrelated history. The replacement fixture has
  8,100 linked records whose access helper raises if invoked, plus slow
  allowed/denied legacy rows, and checks both human wildcard examples under
  a two-second statement limit.
  Owner approved application and protected publication. Management-API live
  readback confirms security-invoker, authenticated-only execute, and the
  partial index. An `authenticated`-role, **no user identity** EXPLAIN ANALYZE
  uses that index and completes the legacy branch in 26.8 ms (24 total
  unlinked rows, including rows without a usable plate). This proves the
  narrowed plan, not the affected human's end-to-end request. Three isolated
  PostgreSQL fixtures, 20 focused UI tests, four desktop/mobile browser cases,
  TypeScript and production build pass. Atlas refreshed with no changed edges;
  existing canonical writer/reader paths remain the actual implementation.
- Live follow-up, 2026-10-19: the human's `RJ%9%8` search returned HTTP
  500 at 22:53:58 and 22:56:25 UTC; PostgreSQL logged statement timeouts
  about eight seconds later. The live caller-role plan evaluated task
  entitlement before organisation custody while scanning observations.
  Prior fixture matching checks did not cover that live policy cost.
  `observations_task_entitlement_select` now uses CASE to skip task-basis
  resolution only when an existing custody/client/Bob policy already grants
  the same row. This preserves the permissive-policy union rather than
  bypassing RLS or raising timeouts. Isolated PostgreSQL tests cover custody,
  client, task-only, denied and NULL-organisation rows, Bob's existing grant,
  and the actual search RPC over 8,000 observation fixtures under a two-second
  statement timeout; the task helper raises if wrongly called on an existing
  grant. Search errors now use the standard logged load-failure helper and
  a specific retry/refinement message for PostgREST `57014` plain objects.
  These checks do not impersonate a live user or establish live-user success.
- Vehicle Search & Flags preserves `%` search patterns independently from
  canonical plate normalisation. Plain fragments match anywhere. Multiple
  matches require explicit identity selection before history or flags load;
  discovery is capped at 50 visible results with a refinement notice.
  `search_vehicle_registrations` is security-invoker: it combines the existing
  public vehicle projection with caller-visible observation plates, so an
  observation-only registration stays searchable without inventing an identity
  or bypassing observation RLS.
- Repeat subject review accepts a NULL agreement as all observations in the
  R&M organisations the caller may administer, including unmapped observations.
  A named agreement retains its accepted-agreement/place filter. The existing
  R&M administrator guard, verified-person requirement, accepted-CCTV rule,
  timestamp filters and pagination remain in force. No unrelated organisation
  access or automatic identity/enforcement inference is introduced.
- Both people and vehicles support a one-sighting threshold. Person summaries
  follow the report's period selector. List, history, vehicle detail, identity
  and comment-mention RPCs share the same scope resolver.
- Atlas inspection proved the report calls its summary RPC, which reads
  observations, CCTV, canonical vehicles and agreement places. The separate
  RPC FK reach was empty, not evidence that those data flows are absent.
  Isolated PostgreSQL fixtures cover mixed places, duplicate place mappings,
  missing agreement mappings, tenant/role denial, accepted/rejected/future
  sightings, both subject types and their drilldowns. Rendered UI and
  desktop/mobile browser fixtures cover wildcard discovery, explicit selection
  and all-scope report requests. These fixtures are not live-user evidence.

Owner ruling 2026-10-18, self-heal repairs the app:

- Evidence: jobs `3e8f7800` and `ea808101` failed with empty diffs. Their
  parents (`8686934c` at `222ecc03`, `f7c6b48c` at `984991f2`) had real
  failures and patches, but were blocked by unrelated e2e baseline failures or
  a lost verifier, then re-opened on a newer main where the guard already
  passed (verified locally at `6c8030c7` and `db5c1649`). The engineer was also
  limited to editing the failing guard file, so a real product regression
  could not be fixed unattended.
- Change: the main-health brief requires reproduction and a root-cause fix in
  the app; release and auto-merge accept up to eight non-protected
  `apps/web/src` files and hold anything else for Grandmaster approval; a
  blocked main-health repair on moved main is handed back to the monitor, and
  a handed-back repair is retired when the monitor opens its replacement.
- Fullstack continuation (owner approved, 2026-10-18): main-health intake now
  accepts named unit/browser failures and creates both engineer steps.
  Integrity-checked specification scopes select the needed lanes through the
  existing audited skip RPC; no model call or invented edit is needed in an
  unused lane. Engineer v7 checks each lane's portion of the acceptance
  contract; whole-job independent review remains mandatory. Backend source,
  additive migrations and browser-test changes can be prepared but require
  Grandmaster release approval. Existing active jobs are not rewritten.
- The saved verifier receipt for `8686934c` identified two reproducible smoke
  failures on current main: the alarm verdict locator matched two legitimate
  status messages, and the map walkthrough expected two verified facets
  although the fixture now has three. Narrowed the former to the exact verdict
  (preserving role/text checks), corrected the latter to the actual fixture,
  and reran both complete specs offline: seven tests passed. This is not new
  permission to bypass baseline failures.
- Verification: 160 targeted Node tests passed, including isolated PostgreSQL
  creation/de-duplication/tenant/privilege checks and verifier-recovery tests;
  the exact four-spec offline worker smoke selection passed all 16 tests
  without retries or skips; application and e2e type-checks passed. Applied
  migration `20261019150000_builder_fullstack_main_health_repairs` through
  the authorized management path, regenerated the catalog snapshot, and
  read back the service-only RPC signature and both enabled lanes. These
  are mechanism and fixture checks, not a claim that a live model-authored
  backend repair has completed or deployed.
- Before/during/after check: a named failure at an immutable main SHA supplies
  the intake evidence; the approved specification selects scoped engineering
  work, unused lanes leave audited skip receipts, and each used lane must hand
  over a real patch plus acceptance evidence. Afterwards, independent worker
  receipts and whole-job review remain required, with backend/consequential
  release held for a human. Atlas proved intake calls job creation and writes
  job/audit records; its FK reach for the intake RPC was empty, not proof of
  absent flow. Refresh used upsert-only to avoid retiring unrelated terrain.
- Release follow-up: the exact `0356f1b3` catalog comparison exposed Git
  stripping a literal CR from the CRLF character class in
  `vehicle_data_sources_authorization_check`. This was not live schema drift:
  the working snapshot was truthful but staging it changed the SQL literal.
  Disable Git text normalization for the generated snapshot only, regenerate
  from live, and verify byte-exact staging/checkout under both `core.autocrlf`
  settings. Keep the release lane's exact catalog comparison unchanged.
- Design references (retrieved 2026-10-18):
  [GitHub Copilot agentic workflows](https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-on-github)
  (repository research, edits, tests and reviewable changes in an isolated
  environment) and [Claude Code common workflows](https://code.claude.com/docs/en/common-workflows)
  (plan, implement, test, and resume). Applied those workflow principles, not
  another application's source or architecture.

Owner-approved structured planning routing 2026-10-18:

- Keep UI design mandatory. UX v9 derives a complete output schema from the
  fitted repository context, including exact route/access/token values and
  empty route lists for surfaces without supplied routes. Local Ollama receives
  that schema; Ollama Cloud retains JSON mode because its documented API does
  not support structured outputs. Semantic validators still gate every tier.
- Carry up to three bounded validation reasons into fallback prompts, never the
  rejected response. Include feedback in the fallback idempotency identity.
- VPS CPU `product_analysis` and `ux_design` calls have a 120-second provider
  budget and a 125-second caller allowance. Two timeouts within five minutes
  cause a five-minute endpoint/model planning cooldown with an explicit
  `provider_planning_cooldown` receipt, followed by normal allowed fallback.
  Successful responses clear the counter. Cooldowns are process-local and
  expire; they do not mark engineering or GPU compute unavailable.
- Do not reorder providers, raise spending limits, run parallel local models,
  or relax privacy, review, approval or release gates.

Acceptance: 170 targeted Node tests passed across gateway/adapter/design,
agentic engineering, runtime/autopilot, product analysis, reviewer identity,
release and deployment guards. Fake-clock evidence proves no provider abort at
119,999 ms and abort at 120,000 ms; fetch-abort and cooldown tests also cover
two-timeout admission, expiry, success reset and unaffected engineering calls.
No live inference was invoked for these checks. Ollama's
[structured output documentation](https://docs.ollama.com/capabilities/structured-outputs),
retrieved 2026-10-18, supports local schema format and explicitly excludes Cloud.

Owner-approved durable Builder recovery 2026-10-18:

- Engineer v6 saves an atomic, fsynced private checkpoint after completed tool
  steps and before subsequent model calls under the persistent
  `BOB_BUILDER_WORKSPACE_ROOT/.engineer-checkpoints` tree (VPS default
  `/data/builder-workspaces`). Diff, compacted context, reading map and completed
  turn count survive a process restart. The disposable worktree may be reset;
  the checkpoint is outside it. A completed proposal receipt is reused rather
  than authored again. Changed inputs start a new revision; corrupt/wrong-pin
  checkpoints or unappliable seeds stop explicitly. Tool calls interrupted
  before acknowledgement may be repeated; a checkpoint is not exactly-once
  execution of an arbitrary external action.
- Ordinary frontend/backend repairs and scheduler-resumed failed verification
  restore the integrity-checked failed patch and failure report. Independent
  review remains mandatory. Prior test claims do not substitute for a new
  independent worker receipt. Verification stages are rerun; completed stage
  receipts are not cached.
- `builder_account_verifier_recoveries` refunds an infrastructure/evidence
  worker claim from the existing engineering counter once per worker/lease
  start, with append-only audit receipts. It runs after classified failure and
  before scheduling following lease recovery. Two recoveries of the same patch
  park it with evidence and work preserved; they do not request another code
  rewrite. Six genuine engineering failures still pause for diagnosis/approval.
  Proven baseline failures also refund the worker claim, then pause without
  retrying or rewriting the candidate. Immutable evidence conflicts remain
  blocked. This does not increase the existing spending authority.
- Browser verification retains line logs and a JSON report. Baseline
  attribution requires the same test identity and assertion fingerprint;
  different failures, missing/malformed reports and browser resource failures
  are not proof the patch is innocent. Repeat the saved candidate once for
  unresolved evidence, then park. Existing unit-baseline tolerance remains
  scoped to named failing files; this is not a new permission to skip tests.
- Terminal checkpoints are removed by the existing seven-day retention pass
  only after activity/approval checks, including when the worktree is already
  absent. Only the newest checkpoint per job/step/lane is kept. Active, paused
  and approval-held jobs retain their work.

Acceptance evidence: isolated process-interruption simulation restores an edit
and tool context, then runs its test and finishes without repeating the edit;
PostgreSQL fixtures prove per-lease idempotent refunds, retained engineering
failures, bounded recovery and service-role-only accounting. These are recovery
mechanism checks, not proof a real Builder job completed end-to-end.
The targeted recovery, worker and idle-safe deployment suite passed 180 tests,
including the isolated PostgreSQL accounting fixture.

Builder recovery 2026-10-18: an automatic continuation must be an idempotent,
transactionally bound child of its source job, preserving the requester,
tenant/project, target environment and release policy. The source is historical,
not active or completed successfully; its recorded successor is an explicit
navigation action. Neither manual runtime execution nor autopilot re-driving
may restart that superseded record. A failed step's actual error takes precedence
over a stale last-completed step or an unrelated pending code-review label.
No automatic resume may be promised without a driving scheduler state.
Cancelled jobs show their steps and failures as history, not approval or
recovery instructions. Control-room request failures identify the attempted
action and HTTP status and decode either function errors or gateway messages.
Main-health intake recognises Vitest's failed-suite markers as well as FAIL
headers, so passing neighbouring suites cannot substitute for the failing scope.
Bob's job lookup reads those same outcome fields, excludes superseded children
from actionable selection, and follows recorded successor IDs for older jobs
whose parent link was omitted. Those read-only report edges remain distinct from
FK parent links; cross-project/organisation targets and cyclic histories fail
explicitly rather than returning partial or misleading success.

Builder execution acceptance 2026-10-18: both Run next step and Run to gate
acknowledge background execution without holding a browser/Edge Function
connection across model work. They share the per-job execution guard;
Run next step still advances only one governed action. Acceptance and
already-running receipts are not completion. Preflight/execution failures
remain recorded, and approval/release boundaries remain unchanged.

Builder activity truth 2026-10-18: model-session heartbeats (`updated_at`)
and the model run's step ID inform freshness and current activity even before
the implementation step is claimed. A model heartbeat proves activity, not
a changed-file manifest, verified patch or completion. Monitor-created jobs
can be driving without a human requester; next-action guidance uses scheduler
state and recorded execution rather than treating that missing requester as idle.

Owner-approved verifier budget policy 2026-10-18: frontend verification has a
45-minute default hard runtime (operator override remains bounded to 5–60
minutes), with the existing renewable lease and global single-verifier guard.
The laptop retains one loaded model and one parallel request. No additional
spending authority is inferred from an account balance. Agentic session token
totals are counted once; transcript/proposal artifact receipts are not new
model calls. Recent token telemetry is not a provider invoice or a USD cap.
Deploy admission checks all running model/worker receipts, not only a two-hour
window, and checks in-process execution after building the image. Unavailable
activity checks block deployment. Explicit forced restarts still interrupt
work; longer timeouts cannot prevent that loss.

The automatic release lane and legacy manual deploy entrypoint use that same
worker/model/runtime idle probe before replacing the control plane, including
after image build. The automatic lane must not treat the gap between generation
and verification as idle; missing credentials, HTTP failures and malformed
activity receipts defer release rather than authorising a restart.

Implementation worktrees validate the requested commit object and their own
clean, exact checkout, not the mutable shared clone's HEAD. Moving the shared
checkout for another job must not invalidate a pinned task. Model exploration
without edits gets a bounded share of the turn and wall-clock budget before handing
its evidence to the next allowed provider. Escalation may replenish turns up to
twice the initial turn allocation, never beyond the original wall-clock limit.
It must not require an arbitrary edit or permit restricted/local-only workloads
to use an external provider. Verification and human release gates still apply.

Owner-approved resource and recovery hardening 2026-10-18: Builder selects laptop
models against installed weight-file sizes and a configured VRAM budget with
reserved headroom, not a blanket minimum parameter count. The measured laptop is
an RTX 5050 with 8 GiB VRAM and 16 GiB RAM; model-size eligibility is not a claim
of current free memory or guaranteed full GPU residency. Output validation,
transport failures, timeouts and account quota errors are separate facts.
Returned usage is retained even when a response is rejected; measured generation
rate never substitutes for validated output, a verified patch or deployment.
Contradictory main-health evidence stops before inference rather than widening
immutable repair scope. Hourly terminal-workspace retention preserves active,
dirty and unpublished work, branches and evidence; only eligible worktrees
older than seven days are removed, without force and with audit receipts.
The designated pre-GitHub source clone is recognised for retiring its old
worktrees only; it is not restored as a parallel build or release target.

Page change requests 2026-10-18: authorised operations roles can submit a
before/desired-after/business-reason brief from the admin or officer header.
The existing `bob_friction_packets` queue owns these requests; there is no
parallel `builder_change_requests` store. The server resolves the submitter,
keeping organisation and role. Route pathname, workspace label and bounded
view headings/tab/title are previewed; form values, table rows and URL query
parameters are not captured. Headings can contain record names, so users must
check the preview and omit sensitive information from free text.

User reports are always significant or protected, never unattended routine
repairs. Only governed triage intake writes evidence and routing; browser
grants permit reviewers to change disposition and note only. RLS restricts
receipts to their submitter and authorised organisation/platform reviewers;
review actor and time are stamped server-side. Builder's review queue can
hand an explicitly untrusted brief to Bob for canon/Atlas/schema/RLS evaluation.
This is not an implementation instruction: any job still requires the existing
separate Builder confirmation and review/release controls. Stop-line reports
are held for platform review, not sent to Bob by this UI. Queue resolution
is a reviewer decision, not proof of a code deployment.

Owner-requested Bob workspace behaviour 2026-10-16: shell chat opens beside the
current working page, shrinking its available width rather than covering it.
Narrow layouts stack independently scrollable page and chat regions. Neither
presentation traps focus in Bob. Studio remains available inside the dock.
Current unanswered guidance offers selectable answers, marks Bob's supplied
recommendation, and accepts a typed override; historical answers and pending
durable requests cannot be resubmitted through old buttons. Budget-pause
receipts persist Continue/Pause options and the saved task state as message
metadata; selecting Continue restores the original goal and completed evidence
instead of treating a document-read result as a pending proposal. Extracted
entities from a document read alone do not create an in-flight proposal.
After a canonical thread refresh, the chat keeps the latest reply in view.
Each send captures the current route and bounded visible headings/control
labels (never form values, table contents, hidden/private regions, or Bob's
own thread), alongside the shell's current selected-entity context. These are
untrusted navigation hints, not authorization or evidence of a completed action:
Bob still resolves records and writes through the existing governed tools.

Bob compliance-register proposals 2026-10-16: an organisation's H&S and
compliance profile is `organization_compliance_records` (policy,
prequalification, licence, insurance, registration, certification, other).
Bob previously could only summarise uploaded H&S evidence because no catalogue
tool could propose a register record. `propose_compliance_record`
(`bob-propose-compliance-record`) now files one pending
`create_org_compliance_record` action per record, for one explicitly resolved
organisation, with source name/date provenance and an optional registered
document or chat attachment. A master approves each action; the service-only
`apply_bob_compliance_record_proposal` RPC re-checks master authority over the
target organisation, applies the canonical validation, supersedes a current
record with the same type and name, audits the write, and leaves the record
`unverified` until a master verifies the evidence. The planner selects tools
by catalogue purpose: an update/apply request is complete only when a matching
governed proposal is filed, or when Bob states that no tool can write the
target. There are no H&S keyword routes.

Owner direction 2026-10-16 (next workstream): build an H&S register and risk
system — hazard/risk register (likelihood × consequence, hierarchy-of-controls
controls, residual risk, owner, review date, linked evidence), site/task risk
assessments with sign-off, a pre-start safety checklist gate, post orders and
H&S briefings staff must acknowledge, incident and field-report links that
trigger hazard review, H&S incident investigation, and Bob-proposed register
entries extracted from uploaded registers and plans. Trackforce Valiant is
inspiration for acknowledged post orders, checklists, lone-worker alerts, and
incident analytics; the register itself is owned by the organisation and place.

Place hazard register and officer safety briefing 2026-10-18 (first slice of
that workstream; migration `20261018090000_place_hazard_register_briefings`):
- **Register.** `place_hazards` holds one specific risk at a house or one of its
  facets (client site or zone) with risk level, controls, and the exact source
  document section. Writes go only through `report_place_hazard` (officer),
  `manage_place_hazard` (administrator: create/update/confirm/retire, audited)
  and `apply_bob_place_hazard_proposal` (service-only, after approval).
- **Bob.** `propose_place_hazards` (catalogue purpose, no keyword routes) files
  pending `create_place_hazard` actions through `bob-propose-place-hazards`;
  `bob-proposal-execute` applies approved ones. A same-title proposal at the
  same place replaces the live hazard and bumps its version.
- **Officer briefing.** `get_shift_safety_briefing` combines the shift's place
  hazards with active `entity_flags` warnings, critical first, under a briefing
  hash. Web officers must confirm "I've read these risks – start shift" before
  starting, and confirm again per patrol stop on arrival and whenever the
  briefing changes mid-shift (`acknowledge_safety_briefing` rejects a stale
  hash). Source sections open through `place-hazard-source` signed links.
- **Officer reports.** Reported hazards are visible to other officers at once
  as "reported — not yet reviewed" until an administrator confirms or retires
  them on the site's hazard register.
- **Delivery follow-through, 2026-10-18**
  (`20261018100000_safety_briefing_delivery_guards`):
  - **Before:** Bob's resumed task retains the original goal, earlier tool
    evidence and nested lookup arguments. Delegated document findings are
    evidence, not completion of a requested register change. The independent
    critic checks that distinction; no H&S keyword routing was introduced.
    Proposal retries hash controls, source sections and scores as well as titles.
  - **During:** web and native officers load short place-specific risks before
    starting. Failed loads block start visibly. Patrol arrival is recorded only
    after the stop-specific acknowledgement. Database triggers enforce current
    officer receipts on shift starts (including direct inserts) and stop arrival;
    replay cannot acknowledge a different shift, stop or version. Unscheduled
    work is prepared with its work-unit contract/route and patrol stops, then
    goes through the same briefing and normal start RPC, rather than inserting
    an already-started shift. A retry reuses the prepared shift.
  - **After:** new officer reports invalidate prior receipts, remain immediately
    visible as unreviewed, and create deduplicated personal review notifications
    for active administrators in the keeping organisation. Site notifications
    open that site; zone/house notifications open the owning Locations workspace,
    which now exposes the same register even without a site facet. Missing
    requested places never silently open another place. The native client
    supports refresh, acknowledgement, signed source links and hazard reporting.
    Full displayed-content hashing includes changed warning instructions and
    source references, not merely warning severity. Management authority requires
    a real organisation/place relationship, not just readable tenant records.
  - **Risk assessment:** administrators can record optional likelihood and
    consequence (each 1-5), see their product out of 25, the keeping organisation
    and overdue review dates. Residual categories remain explicitly reviewed;
    no undocumented score-to-category thresholds are invented.
  - **Evidence:** ten desktop/Pixel-7 Chromium checks cover acknowledged/stale
    starts, load failures, unscheduled starts, pre-arrival confirmation, source
    sections and unreviewed reports. The rollback-only synthetic SQL probe tests
    proposal apply/retry, report/retry/notification, shift/stop/direct-insert
    guards, unscheduled preparation/retry, stale hashes, warning-content changes,
    tenant/place authority, persisted scores, clearing controls and review.
    Web/mobile TypeScript and production web build pass. Native device execution
    and a real human NMDHB document-to-approved-register run remain separate
    acceptance gates; browser fixtures and SQL probes do not establish either.
- **H&S risk-review lifecycle (migration `20261019100000`):** individual risk
  owners, structured hierarchy-of-controls classification, scheduled review-date
  reminders (cron), officer-signed dynamic task assessments (idempotent retry;
  an unsafe assessment opens a supervisor review and never rewrites the signed
  evidence), automatic reviews for H&S field reports, and supervisor linking of
  incidents/investigations with a closure receipt. Evidence: rollback-only SQL
  probe (RLS/immutability as `authenticated`, foreign-investigation rejection,
  null-classification rejection), vitest, web/mobile TypeScript and a
  desktop/Pixel-7 Chromium e2e. `stop_work` records and communicates; it does
  not gate every task API. Native device execution and a real human supervisor
  run remain acceptance gates. Do not describe the entire H&S programme as
  finished.

Owner ruling 2026-10-16: Deputy roster exports are sample/build/test evidence,
not an operational integration or production import workflow. The offline
parser and source-shaped fixtures may be used to test roster mappings and
billing-evidence preservation, but the product must not expose an authenticated
Deputy import action or mutate live roster, leave, staff, workplace, or work-unit
records from that sample path. Future operational imports require a separately
governed source, review, proposal, approval, apply and receipt design.

Release identity incident 2026-10-15: two concurrent agent commits reached
`main` with the local author `don@squires.local`, which is not associated with
the verified Vercel/GitHub owner account. Vercel correctly blocked both
deployments before build; the already-published Builder workspace remained
live and was not damaged. Release identity is now enforced at both shared publication boundaries:
GitHub `main` requires a pull request, and Bob's isolated publisher validates
both its configured identity and the actual branch-head author against
`256263525+DonSquires@users.noreply.github.com` immediately before push. A
concurrency fixture starts Bob from a pinned SHA, advances `main` with another
agent's non-overlapping app commit, then proves the verified integration head
contains both histories and both file changes. A canonical release commit is
required after any historical unverified commit already on `main` so the
complete current tree can deploy without weakening Vercel protection.

Builder job alerts 2026-10-16: terminal Builder outcomes now create one
requester-scoped in-app Bell notification that opens the Builder Control Room.
An in-database five-minute sweep sends a deduplicated warning after 45 minutes
without a job, step, model-run, or worker-run update. Human-held jobs are
excluded, including jobs at `awaiting_human`, `approval_pending`, and
`release_ready` gates. The warning does not cancel or restart work, and the
Notification Center receives inserts through its existing realtime
subscription. This replaces assistant-side polling with durable, auditable
status notifications.

Bob outage and in-house compute ruling 2026-10-16: Bob chat had been down since
2026-10-14 because commit `8f852dfe6` redeclared `explicitAtlasRequest` in
`onspace-ai-chat`, so the deployed function returned `503 BOOT_ERROR`. Requests
never reached the server, which is why jobs could not be sent from chat and no
history persisted. The duplicate declaration is removed without changing that
commit's intent. `scripts/edge-boot-check.mjs` (run by
`test/edge-function-boot.test.js`) now boots every Edge Function before
release, and the VPS release lane probes each deployed function and fails on
`BOOT_ERROR` instead of counting the upload as success. Jobs created on the
Builder New Job page were never bound to autopilot, so #84/#85 sat at intake
with nobody driving them. New and follow-up jobs now default to Bob driving
them to the next human gate, and an undriven job offers `Let Bob drive` (Edge
action `drive`, the service-only `builder_autopilot_bind` with
`can_approve_action`, audited). Owner ruling: Bob's own compute is the primary
workforce. Builder analysis, authoring and review route laptop GPU → VPS CPU →
OpenAI, OpenAI being the paid last resort, and chat code requests plan
in-house. VPS storage hygiene is now repo-managed (`host-hygiene` deploy
target): Gitea dump retention by count replaced a 14-day rule that had
accumulated 202 GB, and the control plane reports disk pressure on `/health`.

Ollama Cloud tier, owner direction 2026-10-18: the owner's ollama.com subscription is a
distinct external provider (`ollama_cloud`), not a replacement for local Ollama. Builder routing
is laptop GPU → VPS Ollama → Ollama Cloud → OpenAI; restricted work is stripped of every
external provider and falls back to local-only. Live evidence: both local machines were healthy,
but the first allowlisted model (`qwen2.5-coder:7b`) failed validation, so steps fell through to
paid OpenAI; the cloud tier puts large hosted models (`gpt-oss:120b` and others) ahead of that
cost. A provider missing from the health report is no longer offered as a candidate.

Owner direction 2026-10-21: unrestricted routing is laptop GPU → Ollama Cloud → OpenAI. The VPS
CPU tier passed 0–3% of analysis/UX runs over 21 days, so it now serves only restricted-data runs
and knowledge-card embeddings. The cloud tier adds `nemotron-3-ultra` after `gpt-oss:120b`.
fcm-api serves `/api/bob/embed`, which had been missing, so every chat retrieval had fallen back to
keyword search. It also backfills pending card embeddings (`bob_cards_needing_embedding`, which
previously had no caller).

Builder coding-workspace integration 2026-10-15: the Builder Control Room now
presents the existing governed build system as one accessible coding workspace
rather than opening Bob over the workbench as a floating modal. Desktop uses
three persistent lanes for the job queue, selected-job workbench, and dedicated
Bob Builder agent; medium layouts dock the agent below the workbench, and
mobile users switch explicitly among Jobs, Workbench, and Bob Builder. The
workbench exposes plan, files and changes, terminal and test output, preview
and release evidence, current activity, questions and blockers, review state,
exact deployment truth, and the next safe action. This is a presentation and
information-architecture change, not a trust-boundary bypass: browser turns
still use the authenticated durable `onspace-ai-chat` path, and Builder
records/actions still use `bob-builder-control-room`, preserving tenant scope,
permissions, audit, idempotency, approvals, GitHub evidence, and exact-SHA
release receipts. Ambiguous client delivery failures now direct the owner to
check the already-created durable request before resending instead of implying
that a model quota or provider timeout proves the Edge Function failed.
An unresolved queued or running request keeps the composer locked and offers
only status and cancellation. The panel unlocks only after the authenticated
status/cancel path confirms Bob has no record of that request ID; it then
offers `Restore prompt` and never a resend or retry-delivery action.

Builder queue hygiene 2026-10-15: durable outcomes and queue status had drifted
apart. Jobs already recorded `autopilot_state=done`, plus old main-health
repairs superseded by a passing current-main receipt, still appeared active.
Bob now retires those workspace-free rows atomically through an audited
service-role RPC, cancels their pending approvals, and preserves their reports
as history. Active model/worker runs, workspaces, pull requests, and legitimate
human gates are stop lines. Unowned manual jobs receive a seven-day quiet
period before they qualify as inactive orphans; nothing is deleted. The first
live reconciliation retained all 82 historical rows while reducing Active from
17 to 0 and Awaiting from 4 to 0: 14 policy-eligible rows retired
automatically, five recent exceptions retired under the owner's explicit
cleanup instruction, and terminal-job pending approvals fell from five to
zero. The resulting history is 65 cancelled, 13 deployed, three failed, and
one historical release-ready record. The Control Room Issues tab now means
unresolved, actionable repair/error work; release-ready, deployed, failed, and
cancelled history remains available in its own status tabs without inflating
the issue count.

Main-health snapshot isolation 2026-10-15: an exact-SHA guard repair passed
targeted and full local suites but failed intermittently in Bob's worker. The
worker mounted the shared Builder checkout read-only; another job could still
force that underlying checkout to a different SHA while the suite was
running. Main health now receives a detached per-SHA Git worktree. Moving the
shared checkout can no longer change files underneath an active verification
container or open a false repair job. GitHub main, Vercel Production, and the
control-plane release ledger reached `9ae6981f`; the false repair and its older
duplicate were retired without a workspace or patch. This documentation-only
follow-up advances main once after that control-plane restart so the next
health receipt exercises the deployed isolation path rather than reusing the
pre-release receipt.

Dispatch main-health repair 2026-10-15: after the Finance guard repair merged,
the full health compiler exposed Playwright request captures narrowed to
`never` because their assignments occur inside route callbacks. Request
captures now use a stable object container. The now-runnable browser case then
proved the two long run-sheet footer actions overflowed the Shift Stops grid
column and were covered by Active Jobs. The footer is a bounded two-column
grid with wrapping labels, collapses to one column on mobile, and its parent
grid item may shrink without painting controls into a sibling column.

Builder publication recovery 2026-10-15: a bounded main-health repair passed
worker verification, security review, and independent review, then opened a
GitHub pull request carrying the auto-merge marker but left it as a draft. The
GitHub adapter had ignored the caller's reviewed `draft` decision and the
autopilot treated any recorded pull-request URL as publication completion,
making an interrupted merge unrecoverable. Eligible changes now open ready for
review, exact-head draft pull requests are promoted before guarded squash
merge, recorded pull-request numbers are recovered from the durable URL, and
an interrupted publication re-evaluates the full evidence contract before it
may resume. Legacy bounded main-health receipts that recorded publication
without a merge decision are reconciled once and receive an explicit decision.
Release-ready reconciliation and deployment verification are processed before
long model-generating work so an older analysis job cannot starve an already
verified merge receipt. Interrupted drafts are promoted with GitHub's
node-bound `markPullRequestReadyForReview` GraphQL mutation, not an unsupported
REST-shaped route, then rechecked for exact head, main base, and open state.
Ineligible work remains draft-only and cannot merge.

Live service-area finding 2026-10-11: R&M organisation settings could preview a
canonical council boundary, then told the user Bob would send it to Approvals
"when you are ready", but exposed no submission action. The page also carried a
hardcoded council-name list despite the geofence ruling that canonical
Territorial Authority names come from the live reference table. The repaired
flow reads `canonical_ta_names`, keeps preview read-only, and creates a pending
`set_org_jurisdiction` action through `bob-propose-org-jurisdiction`; approval,
execution, and visual verification remain separate. Bob's previously unwired
friction-triage organ is now available through the Conductor so a page-level
contradiction can be recorded and routed, while Bob explicitly distinguishes
"reported/routed" from "being worked on" until a Builder job receipt exists.

Live acceptance finding 2026-10-11: an owner build request successfully ran
repository and Atlas inspection but then stopped at a future-tense prose plan.
The conductor now converts that narrow post-evidence outcome into the existing
two-turn `create_builder_job` proposal. Rank enforcement, separate human
confirmation, isolated execution, draft-PR output, and the protected
merge/deploy boundary remain unchanged.

RFQ drafting hardening 2026-10-11: Bob's generic document-draft tool now has an
R&M-specific `rm_rfq` source mode. It binds the draft to the latest completed
inventory run for the caller's approved local-folder source, limits references
to eligible RFQ/proposal paths, preserves manifest IDs, run IDs, relative paths,
hashes, capability and extraction status, and always leaves unresolved
`[HUMAN INPUT REQUIRED: ...]` fields under the existing human-review gate.
Inventory is still metadata, not extraction; Bob must not represent an
unextracted manifest entry as verified source content.

Release acceptance hardening 2026-10-11: the Builder human-test driver now
refuses unexpected approval types, fails on any unsuccessful workspace/commit/
publish/PR response, and verifies that workspace, published, and pull-request
head SHAs are identical. The protected release lane now refreshes Atlas
exercise evidence after the normal Atlas wiring refresh and blocks the lane if
that runtime-evidence refresh fails. These receipts prove the gates; they do
not grant Bob unattended merge or deployment authority.

Owner ruling 2026-10-12: routine self-heal is monitored and automatic rather
than admiral-initiated. Signed-in web runtime errors and unhandled rejections
produce bounded, redacted before/during/after friction packets. Only
high-confidence software bugs with no stop-line or protected/consequential
signals enter the routine Builder queue. The control plane claims them,
commit-pins a Builder job, runs the existing verification/review/autopilot
lane, and may auto-merge only under the existing clean non-evidential marker.
Redesigns, new builds, new capabilities, migrations/schema/RLS/auth,
dependencies/environment, privacy, safety, legal, identity, enforcement,
finance, payroll, and evidential work remain Grandmaster-gated. Expansion
beyond eight changed files also stops at the gate.

Owner ruling 2026-10-12: GitHub is the source repository only; no GitHub Actions
CI, coding agent, Gitea mirror, or release workflow runs. **Superseded
2026-10-24:** the owner lifted GitHub-specific restrictions; Vibe Builder and
Bob Builder remain the primary builders and GitHub provides supporting
automation. The selected topology retains the VPS production writer and
credential-free PR/main CI, not a competing builder or production writer.
Bob's VPS directly
polls the pinned GitHub `main` SHA, runs the isolated web build/unit/source-guard
and Playwright smoke checks, and opens bounded Builder repair jobs for
test-only baseline failures. Auto-merge requires the existing clean
non-evidential gate plus the exact failing-guard allowlist. The VPS remains
fail-closed until its durable GitHub write credential and repository identity
are configured; no ephemeral Codespaces token may be persisted or repurposed.

Dr Bob acceptance finding 2026-10-12: Bob answered a combined Atlas, schema,
and human-test request after running only one paginated Atlas query, while the
Builder UI correctly showed that no work was running. The repaired path gives
Bob a governed `run_human_test` tool backed by the existing isolated browser
worker and a persisted control-plane receipt. Start and status responses carry
the run ID, pinned source SHA, lifecycle state, counts, and artifact inventory;
Bob may not use "running" or "ongoing" language without that receipt. Atlas gap
generation was also corrected to include production JavaScript at the
repository root and to ignore DDL-like SQL string literals. An Atlas `unwired`
classification remains a static-map finding, not proof of a broken feature,
until schema and caller evidence agree.

Dr Bob dispatch and self-heal truth hardening 2026-10-13: an explicit owner
instruction to run fixture-backed and live Dr Bob testing selected web research
instead of the already-wired `run_human_test` tool because the deterministic
guard corrected only plain-answer planner outcomes. The same instruction
contained words such as "inspect" and "status accuracy", which could also
misclassify a leading "Run Dr Bob" command as a status query. Explicit Dr Bob
requests now override unrelated planner tools, start verbs take precedence,
and one durable `suite` receipt runs fixture QA before read-only live QA against
an exact expected GitHub/Vercel SHA and optional approved route. Separately, a
failed main-health repair was displayed as deployed despite having no commit,
published branch, pull request, merge, deployment, or live receipt. The control
plane now corrects such invalid self-heal terminal states to failed with an
audit event. Eligible auto-merged jobs remain in release verification until an
exact-SHA GitHub Production deployment succeeds and the approved live URL
responds; only then can the job be recorded as deployed.

Bob evidence-routing hardening 2026-10-13: subsequent live turns showed two
remaining one-way transitions. An explicit Atlas-and-schema UI gap audit could
escape into generic web research and synthesize after Atlas without reading the
schema. A research-driven Builder request could also hit the four-source gate,
then repeat the same `create_builder_job` failure on "research", "proceed", and
other continuation turns. Explicit Atlas/schema requests now override unrelated
planner tools and deterministically chain Atlas into schema before synthesis.
When Builder reports missing research, Bob recovers the substantial owner build
request from recent history, performs bounded governed web research, embeds at
least four usable HTTPS source URLs in the durable brief, and retries job
creation in the same turn. Failure to obtain four sources remains a truthful
block rather than invented provenance.

Builder chat admission hardening 2026-10-13: a live Codespaces-like Builder
request selected repository search correctly, but that one read consumed the
Edge turn budget. Bob then asked the owner to continue and repeated the same
search on the next turn because implementation research was being performed in
chat instead of in the durable Builder runtime. Explicit admiral software-build
instructions now enter Builder immediately; a short affirmative resumes the
most recent substantial build request. Builder owns repository, Atlas/schema,
research, implementation, test, review, and release evidence. Explicit Atlas,
schema, and Dr Bob commands retain their dedicated read/test routes.
Live acceptance then exposed that the natural confirmation "Yes, open the
Builder job and proceed autonomously" was narrower than the accepted bare
"yes" pattern and fell back into web research. Builder continuation now accepts
bounded natural approval wording while rejecting qualifications such as
"but do not open it"; the substantial request still comes from conversation
history rather than the approval text.
Corrective live acceptance also exposed that "complete and verify this
redesign" was not classified as implementation intent. That caused web research
instead of Builder admission and later made a short "fix this" nudge replace
the substantial brief. `complete` and `finish` now participate in the same
software-target guard as build, fix, and redesign, so the original corrective
brief remains the durable job source.
The subsequent implementation artifact called itself a first slice, omitted
required owner files and responsive styles, ran no web checks, and deferred the
accepted redesign to follow-ups. Agentic Builder now refuses summaries that
admit required work is incomplete, enforces paths explicitly labelled
`Required source scope`, permits bounded web test/lint/build commands inside the
isolated worktree, and reserves follow-ups for optional work outside the
approved acceptance contract.
The next live UX pass exposed a representation mismatch at the same grounding
gate: repository evidence named `BuilderControlRoomPage`, while a valid design
could name its full source path. UX validation now requires the prompt to carry
at least one supplied owner explicitly and treats exact owner names and
path/basename equivalents as the same grounded component; invented-only
inventories still fail.
The first job on those gates then opened the real 1,843-line `BobPanel.tsx`,
but an unbounded `read_file` result retained only its first character-limited
chunk. The render tree at the end disappeared, so the local model repeatedly
guessed an obsolete toy component and every exact edit failed safely.
Oversized reads now preserve the real numbered head and tail, identify the
exact omitted range, and direct the engineer to search or read that range.
Failed exact replacements likewise direct it to a real nearby symbol and
verbatim source instead of another guessed edit.
The governed E2E creation helper also no longer assumes every diagnostic job is
backend-only: operators can explicitly select frontend and backend lanes, and
the helper refuses a zero-lane job. This keeps a planner outage from forcing a
UI repair into the wrong implementation lane.
The next live run exposed an invisible preflight: repository/live-context
assembly happened before the per-job in-flight marker and before the HTTP
response, so a slow preflight looked like an unclaimed implementation step and
allowed concurrent callers into the same gap. The control plane now registers
the lease first, returns acceptance immediately, bounds source/context
preflight, and the edge relay preserves accepted/already-running/start receipts.
The accompanying Atlas audit found strong upstream Builder flow but zero
Builder FK reach despite 32 live schema foreign keys. Atlas refresh previously
generated table/RPC/code flow and trigger edges but no schema FK edges. It now
emits `fk_references` from the live schema as structural evidence only, keeping
those edges separate from `reads`, `writes`, `calls`, and `invokes`.
The first live apply also exposed 4,113 unrelated historical generated rows
eligible for retirement, 4,093 from old schema-flow identities. The existing
large-retirement stop correctly refused that write. Refresh now has an explicit
upsert-only mode that updates current capability/edge truth while leaving every
stale row unchanged; it reports the skipped retirement count rather than
pretending reconciliation completed.
Once FK edges were present, the live `bob_atlas_fk_reach` RPC expanded to the
REST 10,000-row ceiling because it traversed weak `references` edges as if they
were FKs and returned the same node through many paths. The replacement RPC is
restricted to `fk_references`, retains per-path cycle protection, and returns
one nearest path per node. Weak references remain queryable as terrain evidence
but no longer contaminate FK blast radius. Atlas trigger extraction also
accepts quoted trigger names, so Builder's release and review evidence gates
are recognized as wired by their live table triggers.
The same release exposed a receipt-integrity gap: the targeted VPS deploy helper
advanced the repository-wide release pointer even when it rebuilt only one
service, potentially hiding pending migrations or edge functions. Targeted
deploys no longer move that pointer; only the governed release lane may do so
after every classified target and truth-surface check succeeds. Until the
separately recorded generated-edge retirement debt is reconciled, post-release
Atlas refreshes use explicit upsert-only mode and report that stale generated
evidence remains rather than either deleting it or blocking truthful new
evidence.
The release lane also still fetched the historical Gitea mirror even though
GitHub `main` is authoritative and the control plane already had a pinned
GitHub deploy key. It now prefers direct GitHub SSH with strict host-key
checking and uses Gitea only as an explicit fallback when that GitHub identity
is unavailable. Release admission no longer depends on mirror lag or a
provider-specific HTTPS token header.
Migration application used `supabase migration repair --linked`, but isolated
release worktrees intentionally carry no local link metadata. SQL could
therefore apply while its version stayed absent from the migration ledger.
Release now repairs by explicit project ref and treats a repair failure as a
failed receipt instead of logging a warning that could permit false success.
Builder redesign acceptance then exposed a separate local-model admission gap:
the agentic engineer capped its task packet without reserving the system prompt,
the model's output budget, or tokenizer headroom. A packet described as fitting
the 24,576-token GPU window could therefore be rejected before the first tool
turn, and six retries repeated the identical impossible request. The opening
packet now uses the smallest deployed GPU budget with the real 8,192-token
output reservation and conservative tokenizer headroom; later source reading
remains tool-driven and line-bounded rather than embedded wholesale.
Release-lane self-update correction 2026-10-14: the repository contained the
GitHub-authoritative fetch fix, but the VPS executes a deliberately copied
release script and that installed copy still fetched the historical Gitea
mirror. It therefore observed a stale, non-descendant SHA and truthfully
refused every release for more than two hours. The release classifier now owns
a `release-lane` target: a reviewed script or unit change installs the new copy
for the next timer tick without mutating the in-flight process. The first
reconciled run also exposed deleted edge-function paths being treated as
things to deploy; function deployment candidates now come only from added,
copied, modified, renamed, or type-changed paths. The four deleted names were
already absent from the live Supabase function list, so no remote deletion or
fictional deployment was required. The pinned GitHub deploy key remains
authoritative and Gitea remains fallback only.

Builder legacy reconciliation 2026-10-14: live Atlas/schema inspection found
three present-but-unwired prototype interfaces. The single-frontend
`builder_claim_security_review` RPC is superseded by the live aggregate review
claim used by `builder-security-handoff.js`; `get_builder_approvals_activity`
is superseded by the canonical `get_approvals_activity` workbench query; and
the empty `builder_protected_variables` table described tenant-configured
environment injection that fixed-profile, networkless workers intentionally do
not permit. The three legacy entities are retired together rather than wired
artificially. Aggregate review, canonical approvals, worker audit records, and
fixed verification environment remain active.

Product-analysis grounding correction 2026-10-14: a provenance-backed Builder
redesign correctly cited four supplied primary sources but still passed
structural validation while inventing a `bob_job_run` entity, fictional FK and
Atlas capability names, real-time schema editing, and a GitHub Copilot
integration. The approval gate prevented those claims from reaching
implementation. Product Analyst v6 now treats research products as evidence
only unless integration is explicitly requested and validates frontend-only
data proposals, relationship identifiers, and named Bob/Builder capabilities
against the supplied repository/schema context before requesting approval.
The first v6 release also exposed a release-classification shell edge case:
when a changed shared Builder module had no Edge Function importers, an empty
`grep -v` inside command substitution returned status 1 and `set -e` terminated
the lane before it wrote a plan. Empty importer sets are valid for
control-plane-only modules; the merge now uses a zero-safe empty-line filter.
The next live Product Analyst run proved the semantic gate by rejecting
`BobPanel` as a proposed data entity, but also exposed that service-driven
retries repeated the same prompt without the validation reason. Retry actions
now append the bounded prior failure as an explicit correction constraint, so
Bob can self-correct without weakening the gate or relying on a human to rewrite
the brief. A second attempt still proposed `BobPanel` because the concrete JSON
example required one data-model object while the prose required no new entity;
Product Analyst v7 removes that contradiction. Frontend-only/no-backend briefs
now receive an explicit scope contract and an empty `data_model_proposal`
shape, which the validator also enforces.

Natural-language Builder acceptance hardening 2026-10-13: Bob's deterministic
post-evidence Builder fallback now recognises ordinary owner language such as
"build me an app", "add a page", "make this workflow work", and "fix the UI",
without requiring the owner to know Bob's internal Builder term. Bob now carries
the selected mode into the durable job brief: no-code app generation
(user/role/job-to-be-done, schema-backed information architecture and governed
data path), AI-assisted chat-to-code (source-level change), or bounded
autonomous self-heal (reproduce and repair a confirmed defect within the
attempt ceiling). Builder chat exposes a plain-language starter for each mode.
Business-record creation remains outside this software-build classifier. The
same evidence, confirmation, isolated worker, review, protected merge/deploy,
and receipt gates remain unchanged.

Live Builder-monitoring finding 2026-10-13: a plain-language request to research
and redesign Bob Builder stopped at generic UI/UX prose and created no Builder
receipt. After the planner was trained on the three Builder modes, the in-house
model correctly selected web research but repeated the same tool instead of
advancing. The VPS planner now deterministically advances a grounded software
request from completed web research to repository inspection, then from source
evidence to the existing two-turn `create_builder_job` proposal. This guard does
not skip evidence, confirmation, isolated execution, review, or protected
release gates. A terse follow-up such as "proceed" now recovers the original
software request from the conversation, counts successful research subagent
steps as evidence, rejects vague or `not_found` repository searches, and
normalizes premature Builder calls into the actual job argument contract.

Owner ruling 2026-10-13: an admiral's explicit natural-language software-build
instruction authorizes Bob to research, inspect, refine, open, and drive the
isolated Builder job without repeated human "proceed" turns. Bob answers his
intermediate questions with read-only research, repository, Atlas/schema,
drafting, and review helpers. He interrupts only for a genuine specification
fork or a protected/consequential boundary. Merge, deployment, migrations,
auth/RLS, dependencies/environment, and evidential work retain their separate
human key.

Builder concurrency acceptance 2026-10-13: monitoring a live owner-requested
Builder redesign found that the control plane awaited the entire isolated
main-health suite before listing or advancing owner Builder jobs. A new source
SHA or control-plane restart could therefore leave a valid autopilot job at
intake for up to the 30-minute health timeout. Main-health now runs as an
independent single-flight lane with explicit failure recording, while routine
self-heal and owner Builder jobs continue through their existing bounded
governance paths. This is concurrency only: it does not weaken health checks,
verification, review, merge, deployment, or protected-path gates.

Builder research-provenance acceptance 2026-10-13: monitoring the Builder
control-room redesign rejected a second product specification before design
because it named “research integration” but carried zero source URLs or observed
patterns. Research-driven natural-language jobs now preserve bounded research
output and source URLs in the durable brief, cannot open with fewer than four
sources, and require Product Analyst to return structured publisher, observation,
and applicability evidence using only supplied URLs. This is provenance, not
authority for a write; unsupported or invented sources fail validation. A live
owner retest then found that a three-source result ended in another question
instead of continuing the explicit build instruction. An owner-invoked research
build now makes at most one bounded follow-up when fewer than four safe sources
resolve and carries the combined evidence straight into Builder; it does not
weaken the source gate or permit autonomous research without the owner's request.
The next live job exposed a URL/path collision: a researched `/ai-apps/` URL was
read as a repository `apps/` path and incorrectly selected a backend-only lane.
Repository-lane inference now strips public URLs before recognizing source paths,
so research evidence cannot suppress the requested UI design/frontend stages. A
fresh retest then exposed the alternate `repo_search` → in-loop `web_research`
route ending in synthesized design prose. The explicit-owner-build completion
bridge now accepts that researched read route too (with the same bounded follow-up
and source gate) without adding web research to the general autonomous allowlist.
The following run reached Builder but showed `supplied_sources: 0` even though a
research subagent had returned six public sources: planner arguments had dropped
the delegated evidence. Job creation now preserves bounded findings and non-example
URLs from successful delegated `web_research` steps before applying the same gate.
The first fully sourced job then exposed a UX-grounding gap: the designer received
a file map but not canonical token or navigation evidence, and invented a route,
permission constant, Tailwind-like token set, generic approval state, and mobile
accordion. Pinned `PRODUCT_DESIGN.md`, `tokens.css`, and Builder AdminShell evidence
now enter design context. UX validation rejects unsupplied routes, access boundaries,
components and tokens, plus unresolved questions already answered by that evidence.
A subsequent planner variation inserted repository-research `docs/` paths into the
brief and again selected backend-only work. Builder lane scope is now derived only
from the owner's words and owner-named paths; planner prose, delegated findings,
and research URLs cannot authorize or suppress frontend/backend work.
Live UX acceptance then exposed a validator wiring regression: the repository-
grounded validation closure referenced `prompts.context` while the prompt binding
was singular, so all three providers produced output but failed on an undefined
identifier. The callback now uses the actual prompt context and its regression
test invokes the callback, rather than merely asserting that it was supplied.
The corrected callback then exposed two false-negative evidence checks: models
preserved the AdminShell `builder` identifier but omitted its explanatory suffix,
and proposed presentation subcomponents alongside the proven owner component.
Route evidence is now a concise exact identifier; component plans must include a
proven owner but may propose bounded subcomponents. Reused model-run rows also
clear stale terminal timestamps, errors, outputs, and usage when they re-enter
`running`, so the control room does not display contradictory lifecycle evidence.

Builder restart acceptance 2026-10-13: the same monitored redesign exposed a
second orphan class. A control-plane deployment landed after product analysis
claimed its durable step but before the model returned, leaving both the model
run and the step permanently `running`; only isolated worker leases had restart
recovery. On startup the control plane now claims model runs that predate the
new process, records them as interrupted, returns analyst/designer steps to the
existing retryable failure path, and completes that recovery before autopilot
planning. Active model work started by the current process is not touched.

Builder fast-lane acceptance 2026-10-13: the same owner request appeared as
three active jobs. Durable receipts separated the causes: an exhausted UX job
had `autopilot_state=done` but retained non-terminal `design_pending`; a
research-enriched retry bypassed exact-brief deduplication; and the live VPS
configuration sent unrestricted Product Analyst/UX work to CPU Ollama first.
The 30B VPS attempt repeatedly consumed the full seven-minute timeout, the
available workstation 8B repeatedly failed the four-source structured contract,
and the strong provider completed an equivalent specification in about one
minute. Builder now has workload-specific compute independent of chat:
structured analysis, agentic authoring, and review use the strong provider then
workstation GPU, and VPS CPU is reserved for light or restricted work.
Autonomous admission reuses an active same-owner/same-project/same-title job
even when research changes the detailed
brief, and unrecoverable attempt-ceiling blocks finalize the job as failed
before recording the plain-language report. Product and UX prompts expose exact
source/token allowlists to reduce avoidable validator retries. The UX validator
also normalizes a single proven canonical token written in CSS `var(--token)`
syntax or with an explanatory label; unknown or multiple token references still
fail. Because the current canonical file has no spacing scale, the prompt now
explicitly permits an empty spacing-token selection instead of implying that
the designer must invent one. This shortens the lane without skipping
specification, repository grounding, verification, independent review, or
protected release gates.

Builder UX self-healing acceptance 2026-10-15: redesign job
`ffbb648e-0a37-4694-83eb-f9efab037a1b` correctly rejected three UX plans that
paraphrased the supplied AdminShell page identifier, but every retry received
the same prompt and therefore repeated the same route-grounding failure.
`ux-designer-v8` now exposes the allowed route and access identifiers as an
explicit byte-for-byte contract, and the runtime adds the bounded prior
validation error as a mandatory correction constraint on failed UX retries.
Repository grounding remains strict: the repair teaches the next attempt what
failed instead of accepting an invented URL, route, access boundary, or page.
The resumed job `6573c083-6d6f-4245-b6b3-95b0d6c294ba` then proved the repair:
v7 failed its first UX attempt on the same paraphrase, v8 received that failure
and completed the grounded design on attempt two.

Builder agentic-lifecycle acceptance 2026-10-15: that resumed job exposed a
separate false-idle and duplicate-run risk during frontend implementation. The
live agent budget was four hours with 25-minute model turns, but the in-memory
run lease expired after 45 minutes and no `builder_model_runs` receipt existed
until the entire author loop ended. A valid engineer therefore appeared
`pending` for hours, could be killed by a release without an in-flight receipt,
and could be duplicated after the short lease expired. Agentic Engineer now
creates a durable running session before its first turn, heartbeats the active
provider/model, turn number, and changed-file count on every turn, and closes
the receipt on success or failure. The stale-run threshold is also bounded
below by the configured wall budget plus one full model turn and recovery
headroom, so valid long work cannot be mistaken for an abandoned lease.

Builder reviewer context-fit acceptance 2026-10-15: resumed redesign job
`6573c083-6d6f-4245-b6b3-95b0d6c294ba` completed frontend implementation,
isolated lint/build/tests, and the independent static security review, then
failed independent code review because its evidence packet copied a 117 KB
verification log into the 24,576-token GPU context. `independent-code-review-v4`
keeps the exact verified patches, manifests, and security report, but converts
each build log to a digest-bound receipt containing its SHA-256, byte count,
commands, exit codes, bounded diagnostic tails, baseline state, and E2E
selection. A hard 48,000-character evidence limit aborts before provider
dispatch if the remaining packet still cannot fit; review evidence is compacted
rather than weakening the independent review or silently truncating the patch.

Builder delivery-contract acceptance 2026-10-15: continuation job
`b023f045-4e53-44d2-ac11-9f567be68c66` passed isolated verification, security,
and independent review, but its verified result was only five CSS token
substitutions across three files. The original seeded artifact was equally
small; the continuation removed an unused TSX stub and preserved those five
lines. This was a truthful and technically valid patch against a weak approved
specification, not the requested professional workspace redesign. Autopilot was
parked before workspace creation, publication, merge, or deployment.
`product-analyst-v8` introduced machine-readable delivery requirements with
observable outcomes, evidence, and repository-grounded source scope. Broad
UI/UX redesigns fail specification validation unless at least five delivery
requirements and five acceptance criteria cover workspace hierarchy,
desktop/mobile behavior, accessibility/keyboard behavior, all required
interface states, and operational status/evidence visibility across at least
three source files including UI behavior and styling. `agentic-engineer-v4`
then refuses handoff until every approved delivery requirement has completed
evidence naming a changed file from that requirement's own source scope. Passing
tests and reviews remain necessary, but can no longer substitute for delivering
the approved observable outcomes.
Live retry acceptance then exposed that repository-context normalization could
slice an exact owner-named source file from a repository inventory before the
relevance fitter ran, causing a grounded delivery scope to be rejected as
unknown. `product-analyst-v9` accepts a syntactically safe exact source path
when it is present either in fitted repository evidence or byte-for-byte in the
owner's task; unnamed paths still fail closed.
The next live v9 output covered the workspace hierarchy but used a grounded
paraphrase rather than the validator's exact phrase "information hierarchy".
`product-analyst-v10` accepts bounded semantic equivalents (`hierarchy`,
`workspace`, `composition`, `layout`, `navigation`, or `primary action`) for
that one required category; the other four categories, five-delivery minimum,
source-scope grounding, and engineer evidence gate remain unchanged.
Repeated live v10 analysis then showed strong-model outputs summarizing the
required interface states as a generic state requirement instead of naming
`loading`, `empty`, `error`, `permission`, and `success` inside the delivery
contract. `product-analyst-v11` exposes the complete broad-redesign validator
contract as machine-readable prompt input, including minimum counts, exact
category language, all human-acceptance states, and the source-scope rule.
Validation remains unchanged; the prompt now teaches the exact contract it
already enforces.
Main-health self-heal acceptance then exposed that an exact owner/task-named
source path at the end of a sentence was extracted with the sentence's trailing
period, so `FinanceBureauPage.guard.test.ts.` did not equal the grounded
`FinanceBureauPage.guard.test.ts`. `product-analyst-v12` strips trailing prose
punctuation from task-extracted repository paths before exact comparison;
interior path characters and the safe repository-prefix check remain strict.
The next bounded main-health repair then added `package.json` to a one-file
guard-test delivery scope even though the repair brief supplied a required
source scope. `product-analyst-v13` extracts that exact allowlist into the
machine-readable scope contract and rejects any delivery requirement that adds
another file. This keeps automated main-health self-heal inside its proven
failing-guard boundary rather than letting analysis expand into application or
dependency terrain.

Runtime acceptance 2026-10-11: the laptop vision watcher now writes an
independent liveness heartbeat and its Docker health check terminates only a
stale watcher process so `restart: unless-stopped` can recover it. Acceptance
forced both a watcher process crash and a stale heartbeat; each restarted in
one second and returned healthy. Live Bob acceptance also found and repaired
two false-stop paths: a scoped "do not write canonical business records"
boundary no longer blocks an explicitly requested conversation-only document
draft, and Builder autopilot recognizes the worker's `baseline: repository red
at the pinned commit` receipt as a repairable red-main condition. Canonical
promotion, protected merge, and deployment authority remain unchanged.

Owner ruling 2026-09-15: **Field Compliance Manager is the only product we are
building.** GitLab, FreedomCamp-Manager / FreedomCamp-Manager-App, Onspace
previews, and other historical repos are legacy/reference evidence only. Keep
their useful requirements, patterns, samples, and lessons; do not preserve their
architecture as a parallel target, and do not optimise this build for backward
compatibility with those projects.

## 0. Where the good bits come from

| Line | Keep | Do not port |
|---|---|---|
| GitLab `field-compliance-manager` (the live database *is* this build's database) | the constitution now in `docs/canon/`; `resolve_context` P1/P2; `has_location_access` / `user_has_task_entitlement` keystone; Model A; house model; module manifest shape; `PRODUCT_DESIGN`; recovered `rateEngine.ts`, `invoicePipeline.ts`, `resolveOrCreateHouse.ts` (+ tests) in `docs/canon/reference/recovered/` | its stale infra docs (Railway/RunPod/Ollama), the 13.7k-line watch log as authority, 4-digit migration numbering |
| This repository | Atlas / Caddie / Conductor / Oracle implementation; Builder control plane and worker isolation; governed single-transaction module submissions (biosecurity, noise, smoke, field reports); mobile governed scan + evidence/PTT/offline-package RPC contracts; CRM onboarding governance; canonical identity spine work; report packs; 556 root + web test suites; the human-test runner | the hybrid hand-appended `schema.sql` (replaced 2026-09-14); per-module pages that bypass shared spines |
| `FreedomCamp-Manager-App` (Expo prototype) | offline-first field patterns: local cache of zones/rules/flags, durable upload queue with retry, provisional local compliance labelled provisional, photo vault, GPS zone auto-detect, welfare inactivity timers | its tables (`vehicle_observations_v2`, `investigation_jobs`), delete-after-5-failures queue, client-side authority |
| `FreedomCamp-Manager` (web predecessor) | workflow breadth as requirements; governance-gate checkers (route/endpoint baselines); training feature; migration-repair runbook | its architecture wholesale |
| Onspace preview | task hierarchy and scanability only | table names, browser writes, role model |

## 1. Ground truth and guardrails (in place 2026-09-14; keep green)

- `supabase/schema.sql` regenerated from the live catalog (356 tables, 549
  functions, 860 policies) via `scripts/schema-snapshot-live.mjs`; hand-editing
  it is prohibited. **Gate:** the snapshot is re-run after every applied
  migration; a CI drift check is a follow-up once a PAT is available to CI.
- Canon imported and reconciled (`docs/canon/`), `FOUNDATION.md` at root.
- GitLab lineage readable read-only (`scripts/gitlab-read.mjs`).
- Baseline health: 556 root tests, web typecheck and lint clean, 393 unique
  migrations, CSS contracts clean. Atlas refreshed from the truthful schema on
  2026-09-14 under the owner's ruling that a refresh writes only Atlas's own
  tables (`bob_capability_map`, `bob_app_map_edges`): 46 capability upserts,
  90 edge upserts, 3 stale edges retired; live now 1,324 live capabilities /
  6,214 live edges / 1,906 wired / 0 exercised. **Gate (standing):** re-run the
  refresh after every schema or code change that touches shared terrain, and
  re-baseline the gap report.

## 2. Accountability and access conformance (FOUNDATION → ACCESS_MODEL)

The keystone is done: `observations` carries the composed SELECT
(`observations_task_entitlement_select` → `user_has_task_entitlement`). Live
verification on 2026-09-14 showed W1 is further along than the ledger's
2026-08-17 snapshot: `incidents`, `breach_records`, `parking_sessions` and
`vehicle_observations` already carry place-reachable SELECTs; the three
assessment tables carry officer situational entitlement but **no harmed-party
read**; `notices` and `noise_seizures` carry the operator gate only. The anchor
ruling of 2026-09-14 (place of harm grants the read; the person or vehicle doing
the harm is the separately anchored subject) is recorded in
`docs/canon/ALIGNMENT_LEDGER.md` and settles edges 1, 2, 3 and 5.

1. **Apply the drafted W1 slice** —
   `supabase/migrations/20260914100000_harmed_party_read_assessments.sql`
   (guard test `test/harmed-party-read-assessments.test.js`): additive
   harmed-party SELECTs on `noise_assessments` / `smoke_assessments`
   (`complainant_site_id`), `biosecurity_assessments`
   (`protected_land_site_id`), and `noise_seizures` (follows the parent). It
   widens no read until W2 populates the anchors. Applying a migration is a
   protected path: the owner applies it, then `scripts/schema-snapshot-live.mjs`
   is re-run and Atlas refreshed.
2. Recover the 13-scenario RLS oracle from the lineage
   (`supabase/tests/0325_observations_keystone_rls.sql`) and run it here against a
   disposable Postgres (the `backend-verify` worker already boots the pinned
   image) — required before any W2 write contract goes live.
3. W2 record-side: make the harmed-party columns live — the governed submit
   functions populate them (noise/smoke: complainant site; biosecurity: protected
   land) and the review surfaces read them. Lineage plans:
   `WRITE_CONTRACT_SLICE1_SMOKE.md`, `WRITE_CONTRACT_SLICE2_BIOSECURITY.md`.
4. `notices` place-of-harm anchor: derive via `breach_id → breach_records.zone_id`
   for interrupt-tier notices and add `client_site_id` for RMA notices (the live
   `location_id` has no FK and no site/zone); then the additive harmed-party
   SELECT. Subject anchors (`vehicle_id`, `person_id`) never grant the read.
5. Access-basis UX: one shared "why can I see this?" chip + drawer rendering the
   §8 return shape (`resolve_access_basis` is live), applied across observations,
   dispatch, incidents, reports.
6. Model A W0 audit: prove own-rooted orgs (10 of 55 today) are fully operable —
   `get_descendant_organizations`, branch login, `create_client_org`, wizards W1/W2.

**Gate:** oracle green both directions (no leak, no lockout) per table; a
cross-tenant negative test per new policy; completion recorded as
"operationally corrected / doctrinally incomplete" until both W1 and W2 land.

## 2b. Noise control — the two-place model (ruling 2026-09-14)

Design: `docs/canon/NOISE_CONTROL_TWO_PLACE_MODEL.md`. One job, two places
(complainant = harm anchor, protected; source = work anchor), both attended as
geofence-verified ad-hoc stops, complainant contact recorded, END period held as
a dated council rule under the statutory cap (8 days since 21 Aug 2025), seizure
gated on Police presence, and a client report that discloses by basis.

1. **Applied 2026-09-14 (owner-authorized)** — `20260914100000` and
   `20260914110000` are live and in the ledger (`scripts/apply-migrations-live.mjs`);
   schema re-snapshotted and Atlas refreshed. The latent defect (the re-issued
   `submit_officer_noise_assessment` writing a non-existent `shift_id`) is repaired.
2. **Truth table stays green** — `scripts/run-rls-oracle.sh … --oracle
   supabase/tests/20260914110000_noise_two_place_rls.sql` (41 checks, real RLS,
   disposable Postgres, `--network=none`). Any change to the noise RPCs or
   policies re-runs it before merge. The snapshot generator now emits
   `REVOKE ALL ON TABLE … FROM PUBLIC, anon, authenticated, service_role` before
   each table's grants, so a database restored from `supabase/schema.sql`
   carries the live privileges exactly (a fresh Supabase database's default
   privileges had been silently widening `dispatch_job_protected_parties`).
2a. **Direction particulars — applied live 2026-09-14 (owner-authorized)** —
   `20260914120000_noise_direction_particulars.sql` adds one governed command,
   `record_noise_direction_particulars`, writing only the columns `20260914110000`
   created: how the direction was given (oral/written, s.327(2)), to whom
   (occupier / responsible person / unoccupied — notice left), an
   officer-specified shorter period within the council rule (s.327(3);
   `end_expires_at` recomputed), and the s.328(5) entry notice, which is
   mandatory and must be written when no occupier was identified. Officer-owned
   (assessing officer or org admin), idempotent by `client_request_id`,
   audited. Guard: `test/noise-direction-particulars.test.js`; truth table
   extended by 7 checks. Ledger tip `20260914120000`; schema re-snapshotted;
   Atlas shows the RPC present + wired with `calls`/`reads`/`writes` edges
   (not `exercised` — no live invocation yet).
3. **Officer flow — built 2026-09-14** (`apps/web/src/pages/OfficerNoiseControlPage.tsx`,
   guard `OfficerNoiseControlPage.guard.test.ts`): job card with both places and
   the pre-arrival dossier → arrive (verification shown loudly, never blocking) →
   assess (position rule stated; distance recorded server-side) → action (END
   only with a complaint job; seizure only with Police present; statutory
   number required) → contact complainant (identity via the audited RPC only;
   in-person contact requires arrival at the complainant place) → depart (delay
   reason when the SLA was breached) → **direction particulars** (after an END
   or seizure: given orally/in writing, to whom, a shorter period within the
   council rule read from `noise_module_config.end_validity_hours`, and the
   s.328(5) notice when unoccupied — through `record_noise_direction_particulars`
   only; the form mirrors the statutory rules before the server enforces them).
   **Owed:** a human test with a real job on the live build (gate below).
4. **Dispatch intake — built 2026-09-14** (`DispatchConsolePage.tsx`): for
   noise jobs the intake captures the complainant place (known site or address)
   and identity, and writes them through `set_dispatch_job_harmed_party` after
   the job is created; identity never goes into briefing notes. **Site-entry
   seam applied live 2026-09-14 (owner-authorized)** —
   `20260914130000_dispatch_place_site_entry.sql` adds one internal
   resolve-or-create (`resolve_or_create_dispatch_place_site`: house first,
   dedup by address key within the owner org, a house under another org is
   flagged `needs_review` and never reused or forked, provisional centre and
   unverified boundary, audited) and puts both dispatch place writers on it:
   `set_dispatch_job_harmed_party` (re-issued with optional coordinates; a
   resolved address-only complainant place becomes a real site so arrival
   there is `unverified_boundary` with a distance rather than `no_geofence`;
   a supplied site must belong to the job's client or custodian because it
   grants the W1 read) and `create_dispatch_intake_job` (identical signature).
   Truth table 56 checks; guard `test/dispatch-place-site-entry.test.js`. The
   console sends the resolved coordinates and states resolved vs unresolved.
5. **Client report and oversight — built 2026-09-14** (`NoiseControlOversightPage.tsx`):
   the attendance report renders `get_noise_attendance_report` at the reader's
   disclosure level; the review queue flags END without a complaint job, seizure
   without Police present, unmeasured assessment position, and flagged
   attendances (`off_site` / `no_gps` / `unverified_boundary` / `no_geofence`),
   and shows a missing delay reason on a breached SLA loudly.
6. **Legacy import re-anchor** — split the Nelson export's inline complainant
   details into protected parties and two places; each historic attendance
   becomes a stop with its on-site/off-site times.
7. **Smoke and biosecurity** take the same shape (`harmed_party_site_id` on the
   job; `protected_land_site_id` for biosecurity; derived anchors on submit).

**Gate:** the human test in the design doc §7 passes end to end and the
source-side reader's report carries no complainant data.

## 3. Place convergence (LOCATION_HOUSE_MODEL, GEOFENCE_PRINCIPLES)

**Applied live 2026-09-15 (owner ruling; `20260915170000_place_model_convergence.sql`,
truth table `supabase/tests/20260915170000_place_model_convergence.sql`, guard
`test/place-model-convergence.test.js`):** `canonical_places` is the permanent
place registry (kind `site` keyed by address, `zone` keyed by house); every
house carries `canonical_place_id`; every site and zone has a house in its own
organisation, resolved-or-created by trigger on write (items 1 and 2 below are
done: 70 houses back-filled, identity preserved, 3,113 observations still on the
Lowburn registry row); places cannot be deleted (trigger + revoked grants;
`merge_canonical_place` converges duplicates); one SQL address key rule mirrored
by `_shared/addressKey.ts`; the zone→site link, zone nesting, zone address
columns, `client_site_zones` and `get_zone_for_gps` are removed as duplicates.
`resolve_context` now takes the site and owner from the matched zone's house.

1. ~~Every site/zone create path resolves-or-creates the house first~~ — done
   structurally: `zz_client_sites_place_house` / `zz_location_zones_place_house`
   triggers, with the ownership-jump guard, run for every writer.
2. ~~Back-fill houses for the 69 sites and 1 zone without `location_id`~~ — done
   (`location_id` is now `NOT NULL` on both facets).
3. Canonical site-entry pipeline (Q10): inventory every address entry point in
   `apps/web` and route all of them through LINZ autocomplete → dedup → create.
   Dispatch included. **Dispatch slice applied live 2026-09-14** (see §2b item 4):
   both dispatch place writers now share `resolve_or_create_dispatch_place_site`,
   which resolves-or-creates the house first (§3.1 shape, SQL). The edge
   `houseResolve.ts` key now matches the SQL rule and its cross-org hard stop is
   gone (same address in another organisation = same registry place). Remaining
   entry points (CRM `create_crm_site`, investigation and context site creates)
   still take free-text addresses; the key is exact, so they must move to LINZ
   canonical strings or they will create precision duplicates.
4. `resolution_status` audit: `process-officer-scan`, dispatch intake and the
   billing zone-tier must branch on the five outcomes; no boolean fallbacks.
   **Scan pipeline conformed 2026-09-15 (G3; edge function redeployed v610):**
   `process-officer-scan` reads `resolution_status` + `governor_overlap_flag`,
   fails closed (503) on an absent resolver row, refuses an inconsistent match,
   records the status and a distinct loud notice per outcome on the
   observation's `geofence_context`, and returns them to both clients, which
   render each outcome distinctly (`test/geofence-p1-callers.test.js`). Rules
   are applied only on `resolved`; every other outcome stays compliance-unknown.
   Dispatch intake already requires resolved coordinates and creates a
   provisional site through the shared seam (§3.3); a billing zone-tier
   resolver does not exist live yet (no function matches) — it is built on the
   status when finance lands (§8), not retrofitted.

### 3a. Geofence workbench (GEOFENCE_PRINCIPLES P1/P2, Q2–Q7) — taken over 2026-09-15

- **G1 engine — live** (`20260914004000`, applied by the geofence session;
  restored verbatim into the checkout): `boundary_proposals` staging (RLS read
  within reach, no browser writes), `propose_boundary` (measure, area gate per
  `zone_type`, drift, supersede), `accept_boundary_proposal` (human-edited
  shape → live entity, provenance by source, optional verify, history),
  `reject_boundary_proposal` (reason required), `get_geofence_review_queue`
  (sites + zones, worst first), `find_existing_site_for_address` (Q10 dedup),
  browser boundary RPCs revoked from anon. Truth table
  `supabase/tests/20260914004000_geofence_workbench_rls.sql` (42 checks).
- **G1b hardening — applied live 2026-09-15 (owner-authorized; ledger tip
  `20260914140000`)**: `verify_boundary`
  refuses to certify missing/invalid geometry for all four tiers (checkpoint
  geometry derived from point + radius; versioned), pinned `search_path`,
  anon revoked from the verify/version/history helpers. Found by the truth
  table against the live schema: live `verify_boundary` certified "no geofence"
  as verified — the exact P1 collapse. Verified live post-apply.
- **G2 workbench UI — built** (`SiteBoundaryReviewPage.tsx`): queue → LINZ map
  inspection (current teal, proposal amber with draggable vertices) → source
  ladder (LINZ parcel/building via `linz-lookup boundary_for_point_escalating`
  → drawn → point + radius provisional) → accept (+ verify tick) or reject →
  history. No direct `client_sites`/`location_zones` writes. Guard + e2e +
  refreshed baselines.
- **G3 P1 callers — built; `process-officer-scan` redeployed 2026-09-15
  (v610, owner-authorized)** (see §3.4).
- **G4 Tier 4 checkpoints — applied live 2026-09-15 (owner-authorized;
  ledger tip `20260915100000`)** —
  `20260915100000_checkpoint_tier_workbench.sql`: `manage_patrol_checkpoint`
  (Q3 direct save at a site within reach, map position required, radius from
  `org_geofence_config.checkpoint_radius_m` else 5 m (Q8), idempotent create,
  versioned in `geofence_boundary_history` as point + radius (Q4), audited);
  a BEFORE INSERT/UPDATE trigger that forces every placement to land
  `unverified` and resets verification on any geometry change, whoever wrote
  it (structural P2 — RLS lets an org admin edit the table directly);
  `record_officer_checkpoint_visit` re-issued with its exact signature so the
  visit's distance and `within_radius` are measured by the server from the
  recorded point (the officer client's claim is audited, not stored) and the
  checkpoint's verification state is recorded on the visit
  (`checkpoint_verification_at_visit`). Before this, live had no checkpoint
  create path at all (0 rows), no P2 reset, and the visit writer stored what
  the client asserted. Truth table extended to 58 checks; guard
  `test/checkpoint-tier-workbench.test.js`. Workbench UI: a "Checkpoints
  (Tier 4)" panel on every selected site — list with state, place by picking
  a point on the map or typing coordinates, move/resize, (de)activate, and
  verify only after the "position inspected on the map" tick. Admin sidebar
  entry renamed to "Geofence Workbench".
- The snapshot generator now also emits `REVOKE ALL ON FUNCTION … FROM
  PUBLIC, anon, authenticated, service_role` before each function's grants
  (same fidelity gap as the table fix: default privileges in a fresh database
  had widened `_gbh_next_version` to anon/authenticated in the oracle only).
- **Remaining:** Tier 1 organisation
  jurisdiction through the governed proposal path (Q5) with map preview; Q6
  source registry rungs (council ArcGIS / NZTA) as proposal sources; backfill
  of the 75 unverified sites through the queue (human work, not a script);
  human test of the workbench on the live build (propose from LINZ → edit →
  accept → verify → place a checkpoint → scan resolves).
- **Place map boundary review (2026-10-17, NMDHB ED Department evidence):**
  the proposal ledger showed a hand-drawn work-area shape accepted and then
  overwritten four times by the house's LINZ parcel. The stale LINZ preview
  still offered a second "Confirm this boundary" button after the drawing was
  saved, and the drawn corners stayed on the map, so the overwrite was
  invisible. The "need review" chip also counted the unbounded NMDHB Site
  without naming it. Now: any save retires the LINZ preview and drawn corners;
  the preview button says "Use"/"Replace with this LINZ boundary"; the house
  parcel is auto-saved only onto a Site, never a work area; the map lists each
  Site/work area still needing review with a jump to it; and
  `propose_boundary` keeps `house_map`/`canonical_place_seed` provenance
  instead of relabelling it `workbench`.
5. `location_events`: either land the governed writer (dual-write from the
   module submit functions) or keep it out of every UI as an explicit seam.

**Gate:** zero facets without a house; zero free-hand address inputs; the five
`resolution_status` outcomes each proven with a stress point; Atlas shows a real
`writes` edge into `location_events` before any surface reads it.

## 4. Field-operations spine (UNIFIED_FIELD_OPERATIONS_MODEL)

1. Server-side effective-toolset resolver: person eligibility ∩ place capability
   (`organization_modules`, `site_services`) ∩ assignment grant, plus the base
   toolkit — one RPC consumed by web and mobile instead of per-shell hooks.
2. `patrol_routes → assignments` rename as its own additive migration + code
   sweep (name, call sign, type, parent/child already exist as columns).
3. Roster staffing lifecycle states `unstaffed → offered (direct|open) → owned`
   with decline/withdraw, feeding presence, SLA, timesheets and welfare.
4. Presence proof identical for static and patrol (`shift_stops`,
   `patrol_checkpoint_visits`, GPS), surfaced to clients as "your site was
   serviced".

**Gate:** one guard, one shift, three tools, two places, end-to-end in the
human-test runner, with roster → arrive → work → evidence → report → invoice
line each leaving an audit receipt.

## 5. Module-as-data unwinding, Freedom Camping as the reference vertical

1. Register every module in one manifest with `requiresSpines` (target shape in
   `docs/canon/MODULE_INTEGRATION_CONTRACT.md`); reconcile
   `specialtyModules.ts`, `platformModuleManifest.ts` and
   `_shared/moduleProfiles.ts` into it.
2. Unwind the FC-first forks named in `PLATFORM_ENGINES_AND_MODULE_PROFILE.md`
   §7: one classify path with module prompt/model as data; template-driven
   notices with no hardcoded FCA HTML; profile-driven geometry create/update;
   bespoke detail tables only where the shared spine cannot express the fact.
3. Finish the FC blueprint sequence: SCV CSV import + NZSCV fallback, scanner
   modes (standard / zoom / detail / bulk), notice draft + on-site print behind
   the fire-control key, admin and client reporting.
4. Per-module settings surfaces wired to `module_rule_sets` /
   `jurisdiction_rule_sets` / `*_config` — no council-specific constants in code.

**Gate:** adding a module touches manifest + data only; the standalone
"login and scan" mode works with one module lit; FC breach → notice → report
proven with evidence chain intact.

## 6. Officer shell and court-readiness UI (PRODUCT_DESIGN)

1. Verify the four-state entry machine (standby / roster-first home / module
   selector / module portal) and the always-visible Field Safety Bar and PTT bar.
2. Evidence metadata strip under every photo; audit-trace footer on every detail
   page; skeleton and empty states everywhere; WCAG 2.2 AA.
3. Enforced enforcement ladder (warning → infringement → NTV), pre-arrival safety
   dossier acknowledgement, human fire-control key before print — all logged.

**Gate:** human-test report per shell with before/during/after evidence; the 107
walkthrough findings and the Playwright red list triaged to zero or to issues.

## 7. Mobile offline field client

Rebuild the prototype's offline depth on current contracts: server-issued data
package (`get_officer_data_package`), multi-type durable upload queue (never
delete on failure), provisional local compliance labelled provisional until the
server verdict, photo vault with SHA-256 registration, background GPS with
`record_officer_breadcrumb`, welfare timers on `officer_welfare_settings`, device
push via `officer_device_tokens`.

**Gate:** three days offline simulated; every queued item replays idempotently;
no record is authoritative until the server says so.

## 8. Finance and pay (ENTERPRISE_READINESS_REVIEW G1 first)

1. Re-implement `rateEngine` from the recovered source **with
   `rateEngine.test.ts` first** (resolution specificity, effective dating, money
   math, per-block billing, pay lines, SLA bands, determinism, no silent zero).
2. Completion pipeline → idempotent `dispatch_job_pay_lines` → finance review
   queue → invoices → Layer-2 on-charge; adjustments by supersession, never
   destructive updates.
3. Bureau/zone-tier pricing rides `resolve_context`; therefore Workstream 3.4
   precedes go-live.

**Gate:** every pay amount explainable from the completed evidence and the rule
version that produced it; duplicate completions idempotent; cross-tenant negative
tests.

## 9. Bob (BOB_DOCTRINE)

Ruling 2026-09-14 (recorded in `docs/canon/BOB_DOCTRINE.md` §9): the **chat
lane** is governed on what is shared with the user, by rank, owner unrestricted;
the **agentic lane** works as a coding agent works — plan, implement, verify,
iterate — with subagents supporting and verifying, stopping for a human only at
the protected paths (merge, deploy, migration/DDL, auth/RLS, dependencies,
destructive bulk operations).

1. Root-cause the planner's empty-reply turns (`callPlan` → VPS `/api/bob/plan`)
   using `bob_event_log`; the fallback text fix shipped 2026-09-14 is a stopgap.
2. Agentic lane: let the bounded Builder runner continue through implement →
   verify → repair loops on specialist evidence (independent code review and
   security review as the verifying subagents, different model identity from the
   author) instead of pausing for a human after each specialist action; stop at
   a protected path, a blocked state, an unrepairable verification failure, or
   the operational action ceiling. Keep `release_ready` as the hand-off to the
   human for merge and deploy.
3. Chat lane: re-prove the four-tier egress model per rank (the lineage's #324
   finding that a `master` reached full cross-org resolution), and wire the
   Tier-3 HSWA duty-to-warn path (`safetyFloor`) end-to-end. Operational writes
   from chat stay behind `isGovernanceLocked` until a separate ruling names the
   write classes.
4. Populate `bob_capability_map.exercised` from real invocation evidence
   (edge-function logs, `bob_event_log`, RPC stats). **Implemented 2026-10-11:**
   118 capabilities are supported by 11,289 invocation observations; static
   refresh preserves rather than invents those claims.
5. Cockpit primitives: who-is-flying indicator, takeback, result-in-habitat.
6. Re-create the RunPod QA endpoint and run `full-page-audit` on Bob's
   infrastructure.
7. Compile every document and media perception path into the shared evidence
   contract in
   [Bob enterprise agent architecture](BOB_ENTERPRISE_AGENT_ARCHITECTURE.md):
   deterministic
   candidates and conflicts, immutable-source/derivative receipts, typed
   confidence, human review state and guarded canonical promotion. Start with
   NZTA/plate OCR, then CCTV/ALPR, face candidates, person tracking, vehicle
   attributes, smoke/noise/biosecurity and Desktop V2.
8. Add verifier-level claim-to-evidence checks: every high-risk identifier in
   generated prose must equal a structured field with sufficient authority, or
   the turn returns review-required rather than a confident answer.

Phase B document-identity slice shipped 2026-10-11: the shared versioned
perception envelope, field candidates, calibration receipts and append-only
review history are live; NZTA OCR writes replay-safe source/model receipts; and
the deterministic verifier blocks unsupported plate claims. Raw candidate
reads are administrator-only pending the domain-specific task-entitlement
policies delivered with each Phase C adapter.

Phase C CCTV ALPR slice shipped 2026-10-11: plated CCTV observations now compile
into replay-safe shared perception envelopes after derivative persistence.
Original evidence/frame hashes, raw and corrected reads, source/enhanced
comparison, ALPR quality, crop width, minimum character confidence and temporal
consensus remain inspectable. Weak or conflicting reads cannot become verified
candidates. `cctv_entity_observations.review_state` remains the single human
decision and is projected into shared authority and review receipts. Raw access
remains administrator-only pending a separately tested CCTV task-entitlement
policy. Vehicle-attribute and vertical-module adapters remain.

Phase C CCTV person/face slice shipped 2026-10-11: source/frame custody,
presence, face-detection provenance and pseudonymous portfolio evidence now
compile into the shared envelope. Raw face/appearance templates, candidate
names and identity lists remain in the governed CCTV biometric store and are
not duplicated. Machine face similarity remains provisional because
relevant-condition and demographic calibration is absent. Existing CCTV review
approves presence; only an explicit human person link/new-person action creates
a human-approved shared identity reference. Vehicle attributes and
vertical-module adapters remain.

Phase C CCTV vehicle-attribute slice shipped 2026-10-11: make, model, colour,
body type and year now retain per-field provenance in replay-safe shared
receipts. Trained OpenVINO colour/type, heuristic fallback and vision-LLM
make/model sources remain distinguishable and always require human review.
Plate acceptance now creates or links vehicle identity without seeding visual
attributes. The dedicated attribute review is the only canonical promotion
path and records corrections without erasing the original candidate. The live
backfill recorded 190 envelopes from 177 jobs and replayed all 190
idempotently. Smoke, noise and other vertical-module adapters remain.

Phase C biosecurity-photo slice shipped 2026-10-11: the governed submission
retains structured classifier details, reasoning, confidence and model receipt,
then compiles species, density and threat-level candidates into replay-safe
shared evidence. Machine inference cannot confirm species or mutate notices or
MPI referrals. An explicit administrator field review is distinct from
operational workflow triage and preserves corrected machine candidates as
superseded evidence. The oversight surface now signs and displays private photo
evidence with custody and authority state. Production verification found one
legacy evidence link without a custody hash; two replay attempts both failed
closed as `missing_source_hash`, with no fabricated envelope. Smoke, noise and
other vertical-module adapters remain.

Phase C smoke-photo slice shipped 2026-10-11: before capture, an officer must
select the source place, confirm the observed source and provide any notice
number required by the chosen legal action. During capture, the caller-context
receipt preserves notes and structured model provenance while the service-only
projection creates advisory visible-source, visual-severity and
visibility-impact candidates only from hash-backed evidence. After capture,
photo classification, legal/operational action and workflow review remain
separate attributable decisions; machine inference cannot establish a breach,
notice, legal basis or closure. The responsive oversight surface shows
short-lived private evidence, custody, officer notes, confidence and model
provenance, and desktop/mobile Chromium acceptance passed without browser
errors. The mobile field surface now shows the captured image before submission,
supports replace/remove, sends separate officer notes, names every outstanding
requirement, uses glove-safe controls and repeats the machine-authority boundary
before the officer confirms the source. Evidence time is bound to successful
photo capture rather than form mount, and changing the observed address, source
type or photo revokes the previous source confirmation. After submission, the
mobile surface retains a durable receipt that separates the officer's legal and
operational record from Bob's candidate, confidence, reasoning and model
provenance, including an explicit unavailable state and supervisor-review next
action. Production presently has four legacy assessments but no evidence links;
two replay attempts for each returned `missing_evidence_link`, while a
nonexistent assessment raised the missing-record guard. This contradicts the
historical assumption that every assessment could be projected, so the records
remain visible as a custody gap rather than receiving fabricated envelopes.
Other remaining vertical-module adapters remain.

Phase C noise-photo slice shipped 2026-10-11:

- **Before:** the officer must have an active entitled profile, select the
  source place, preserve any complaint/harmed-party place already held by the
  dispatch job, and capture a private source/equipment evidence photo. The photo
  is supporting visual evidence only; it cannot supply an acoustic reading.
- **During:** the caller-context receipt retains the two-place, GPS, H&S,
  Police, matrix, action and notice gates. Original and watermarked evidence are
  hashed and privately stored before a service-only, replay-safe projection
  creates visible-source, equipment and visual-activity candidates. Invalid
  classifier output now fails explicitly rather than returning a
  success-shaped `unknown`.
- **After:** photo classification, the officer's acoustic/legal decision and
  workflow review remain separate attributable actions. Human photo review may
  confirm, correct or reject candidates but cannot change matrix scores,
  enforcement action, notice or END fields. The responsive oversight register
  uses practical narrow-screen cards, short-lived evidence links and full-width
  safe actions; desktop/mobile Chromium capture and review passed without
  browser errors.

Production has 76 legacy noise assessments, zero governed evidence links and
zero `noise_photo` envelopes. Two replay attempts per assessment returned
`missing_evidence_link`, the counts remained unchanged, and a nonexistent
assessment raised `Noise assessment is missing`. The expected-versus-present
gap is therefore explicit: historical rows remain usable as legacy operational
records but cannot be represented as hash-backed photo evidence, and no missing
complaint place, media or envelope is fabricated.

Phase C access-control slice implemented in source 2026-10-11:

- **Before:** physical access control existed in agreements, zones, module
  profiles and seeded customer configuration, but the visible “Access rules”
  page administered staff permissions rather than field access events. There
  was no typed officer event, shared perception adapter, officer field route or
  mobile capture workflow.
- **During:** the new service-only receipt validates actor, module and canonical
  place authority; writes a tenant-scoped access event, location projection,
  evidence custody links and audit receipt. A separate pre-decision endpoint
  uses deterministic local face, person/body, vehicle and plate inference plus
  the existing organization-scoped portfolio matcher to rank possible people
  and vehicles. Web and mobile show the probe beside available reference or
  prior-sighting images before the officer records the outcome. The durable
  receipt reruns recognition independently rather than trusting browser-supplied
  candidates, strips embeddings and projects ranked matches as review-required
  candidates. Optional photos preserve original and watermarked derivatives
  with separate hashes, and recognition failure remains explicit rather than
  inventing a fallback.
- **After:** source contracts, web/mobile TypeScript, both Deno functions and
  the production web build pass. Bob may discover and rank likely identities or
  vehicles, but cannot confirm identity, validate a credential, decide
  entitlement or grant entry. A disposable Supabase Postgres database on the
  private Tailscale VPS route loaded the live schema snapshot and protected
  migration and passed executable checks for receipt/perception replay,
  evidence custody, person/vehicle candidate projection, RLS, grants and
  indexes. That run found and corrected an ambiguous PL/pgSQL `id` reference
  and an invalid perception `value_type`. The migration and both access
  functions were then deployed through the linked Supabase project; the live
  migration ledger, Data API exposure and unauthenticated 401 boundary were
  verified, and `supabase/schema.sql` was regenerated from the live catalog.
  Deployment checks then found missing Edge Function inference bindings and an
  older VPS image without `/infer/enhance`. The project secrets were bound to
  the authenticated public inference endpoint; the old image was tagged for
  rollback; and only `fcm-inference` was rebuilt and recreated through the
  private Tailscale route. Docker health, public HTTPS health, OpenAPI route
  presence and authenticated route validation pass. A role-specific image
  workflow is not yet glass-proven because no dedicated access-control test
  identity is configured, and a real user's credentials were not used as a
  substitute. Offline mobile event replay, calibrated tenant matching and
  dedicated-test-identity acceptance remain intentionally open.

System-wide Bob acceptance gate shipped 2026-10-11:

- **Before:** Bob's domain checks existed as separate suites, so a plate guard,
  CCTV adapter, Desktop V2 rule or Builder ceiling could regress without one
  named release check proving the whole agent boundary.
- **During:** `npm run bob:enterprise-readiness` now executes the original
  `JJJ739`/`11739` regression directly, verifies every declared implementation
  and test path, and runs representative cross-domain tests. The inventory
  records each subsystem's authority boundary and present state.
- **After:** the current result is five implemented domains, five partial and
  no full gaps. Access control now has a source-complete field/evidence slice
  but still requires protected deployment, disposable-database proof, offline
  sync and calibrated tenant matching. Parking/freedom-camping projection,
  Desktop V2 offline receipts/reconciliation, cockpit UX and perception
  calibration also remain partial. Atlas exercise is now backed by invocation
  evidence rather than static inspection. The strict command fails while those
  declarations remain, so the repository cannot honestly claim complete
  enterprise Bob readiness yet. Grandmaster is retained as an authenticated
  server-owned rank, not exposed as an ungoverned client-selected Bob
  personality.

  Durable chat execution slice implemented in source 2026-10-11:

  - **Before:** the browser held the `onspace-ai-chat` request open while the
    planner, verifier and tools ran. A glass test returned correctly but remained
    on “Waiting for Bob” for about two minutes, near the hosted Edge Function
    request-idle ceiling.
  - **During:** `bob_turn_runs` now supports `queued`; the browser sends
    `operation: enqueue`; the Conductor returns `202 Accepted`, dispatches one
    protected background execution, and atomically claims only the matching
    queued run. The UI polls every four seconds and supports queued or running
    cancellation without resubmitting the prompt.
  - **After:** completed runs refresh the canonical persisted transcript.
    Reloading or reopening a conversation restores its newest active run and
    resumes polling without duplicate execution. Failed or cancelled runs
    remain explicit and recoverable. The original caller JWT, organization,
    conversation, workspace, rank and effect gates remain binding during
    background execution.
  - **Evidence state:** migration `20261011043559` and `onspace-ai-chat` are live;
    the schema snapshot and Atlas were refreshed. Focused durable-turn and
    BobPanel tests, including reload reconciliation without duplicate enqueue,
    full repository tests, web TypeScript and the production build pass. Two
    consecutive browser glass runs returned control immediately,
    showed the durable run progressing independently, automatically refreshed the
    transcript, and completed successfully in 35.627 s and 34.675 s. The live
    security advisor reported no finding related to `bob_turn_runs`; its broader
    pre-existing findings remain an enterprise-hardening backlog.

  Historical false-plate correction slice implemented 2026-10-11:

  - **Before:** one persisted Bob reply presented `11739` as a verified plate
    even though the supplied NZTA source showed `JJJ739`. Live read verification
    found no `11739` or `JJJ739` row in canonical vehicles, tenant vehicles or
    vehicle observations, so the false reply had not been promoted.
  - **During:** migration `20261011050735` keeps the original reply for audit,
    flags it, appends one source-grounded correction, and links both messages
    through metadata. The bounded migration is idempotent and creates no vehicle
    identity record.
  - **After:** BobPanel labels the original **Superseded by correction** and the
    appended message **Audit correction**. The correction requires source-image
    comparison before identity promotion. Focused BobPanel tests, TypeScript,
    the full 1,051-test repository suite and the production web build pass.

  Page-context and Studio truth slice implemented 2026-10-11:

  - **Before:** the browser supplied agreement, site, zone, workflow and page
    context, but the Operations conductor discarded every field except
    `agent_mode`. Studio treated every assistant reply, including a rank-block
    message, as a version of the selected RFQ/document type. Two-turn laptop
    and Builder proposals asked for yes/no only in prose.
  - **During:** Operations context now passes through a capped allowlist of
    page/workflow identifiers and safe entity summaries. Studio requests add an
    explicit artifact type and document kind, and the conductor persists those
    fields with the sanitized agent context. Proposal and blocked-action
    metadata carries selectable options and safe relative navigation actions.
  - **After:** Bob can reason from the page context already supplied by the app;
    Studio excludes ordinary answers and failures; confirmation choices render
    as buttons; blocked document work can open the pre-seeded document Studio.
    Builder receipts now state the protected truth: Bob creates a draft pull
    request but does not merge protected branches or deploy production.

  Organization-bound document source slice implemented 2026-10-11:

  - **Before:** the R&M corpus had an approved tenant-bound local source alias,
    but Atlas showed no reader/writer flow. The only live laptop capability was
    an admiral-only exact-command shell, unsuitable for a resumable 140,000-file
    corpus. Browser upload could not safely carry approximately 881 GB.
  - **During:** added a durable source-run queue with lease/cancel semantics,
    relative-path-only manifest entries, capability/sensitivity/quarantine
    classification, bounded hashing and deduplication receipts. Added a
    read-only laptop worker, Bob tool, and Files-workspace progress UI.
  - **After:** admin/master callers can ask Bob to inventory the approved source
    without arbitrary shell authority. The result is a staged evidence manifest
    for Bob's writer/creator lanes; no business truth is promoted by inventory
    itself, and consequential writes continue through governed proposals.

  Governed chat document creation slice implemented 2026-10-11:

  - **Before:** live acceptance proved Bob could inventory, investigate, reason,
    and plan, but a request to persist a custom draft was refused because the
    chat catalogue exposed no document-create tool.
  - **During:** exposed the existing audited `create_bob_document_draft` and
    `submit_bob_document_for_review` path as `create_document_draft`, with
    administrator scope, explicit-write refusal enforcement, title/type/content
    caps, escaped HTML, and conversation-only scope.
  - **After:** Bob can return verified document/version IDs and a safe Studio
    destination. Publication, output, signing, and business-record promotion
    remain separate human-reviewed effects.

  Owner/grandmaster Bob workspace acceptance implemented 2026-10-11:

  - **Before:** live owner acceptance found that Studio could report itself open
    while remaining hidden in compact mode. Expanding it preserved incidental
    side panes, compressing chat, Studio, and context into three narrow columns.
    Private source images were listed as a file count rather than shown in the
    conversation, and a successfully persisted document still appeared as
    `Documents 0` because Studio knew only prompt-originated artifact metadata.
  - **During:** the Studio control now expands the workspace and closes session
    and context panes; returning to compact mode closes those full-workspace
    surfaces. Conversation images use short-lived signed URLs, show source
    provenance and processing state, and provide an accessible full-size
    action. Successful `create_document_draft` receipts now carry the exact
    governed artifact title, type, and authored text already submitted to the
    document RPC.
  - **After:** chat can show private source-image thumbnails without exposing a
    storage object publicly; Studio is a deliberate two-surface workspace
    rather than an accidental three-pane squeeze; and persisted document drafts
    appear as Studio artifacts whose preview is the authored draft rather than
    the creation receipt. Desktop and mobile Playwright acceptance, 40 focused
    component tests, conductor contracts, TypeScript, and the production web
    build pass.
  - **Live R&M continuation:** the approved local source completed with 140,826
    discovered files and zero failures. Chat rendered a private source image;
    Studio rendered that media, a generated Mermaid diagram, and a newly
    persisted conversation-scoped document with Copy/Download actions. The
    acceptance pass also found and repaired two presentation defects: checking
    a live durable request could show `Failed/paused` beside `running`, and a
    large Mermaid graph was scaled below readable size. Native labels were also
    lost because the secure SVG sanitizer removed Mermaid's label containers.
    Active durable states now take precedence over stale transport messages,
    and diagrams retain a readable native width inside the scrollable Studio
    canvas while the sanitizer preserves a text-only Mermaid label allowlist
    and removes executable or embedded foreign content.
    Non-admiral
    document receipts now explain that references are rank-protected instead of
    presenting unexplained `[id]` placeholders.

  Guided app-operation bridge implemented 2026-10-11:

  - **Before:** Bob could file governed record proposals and the approval
    workbench could approve/apply them, but the chat stopped at prose telling
    the user to find the approval surface. The action was not preselected and
    the user could not see a persistent before/during/after workflow in the
    conversation.
  - **During:** successful proposal metadata now carries an exact tenant-safe
    `/admin/approvals?actionId=...` destination and a persistent three-stage
    workflow (`Proposal prepared` → `Human review` → `Apply and verify`). The
    approvals workbench consumes the action ID, opens the Decisions area,
    preselects the exact action, and retains the canonical `can_decide` check,
    required reasoning, and separate approve/apply executor.
  - **After:** Bob can visibly walk a user from a chat request to the precise
    review screen and its real buttons without pretending that navigation is a
    database write or bypassing rank. Application still occurs only through
    `bob-proposal-approver` / the governed executor, and the resulting record
    receipt remains visible in the approval activity.
  - Live R&M acceptance found and corrected a separate context-handoff defect:
    opening Bob from a selected approval routed to the command-centre page and
    replaced the source page with generic `page: bob` context. The command
    centre now carries a sanitized source snapshot and return path in router
    state; the conductor admits the exact `action_id` and source page path as
    descriptive context only. A repeated read-only question must therefore
    identify the selected action rather than an unrelated prior Studio draft.

  Autonomous repair and visible-operation bridge implemented 2026-10-11:

  - **Before:** a high-confidence `bob_friction_packets` route stopped at
    “repair ready,” so the user still needed to restate the request and confirm
    a separate Builder proposal. Builder could verify, review, auto-merge
    eligible non-evidential work, and release it, but the product specification
    did not require the repository-wide before/during/after, schema/Atlas, and
    human-glass evidence used by the app canon. Post-release Atlas/schema truth
    was also a manual follow-up. Ordinary navigation was a handful of
    one-off links rather than a bounded Bob capability.
  - **During:** when the platform owner explicitly asks Bob to fix/self-heal an
    app/code problem and `triage_friction` returns a repair route, the Conductor
    deterministically creates the existing governed Builder job in the same
    turn, preserving the friction packet ID and returning the real job/pinned
    commit receipt. This shortcut cannot be model-spoofed: it requires admiral
    rank, an explicit repair/build request in the human message, and the packet
    emitted by the triage function. Builder specifications now require
    expected-versus-present evidence for before/during/after, schema checks,
    Atlas capability and proven flow checks with FK/weak-reference separation,
    and a role/route/job-specific human acceptance path. Auto-merge now also
    requires the actual isolated worker log to prove the relevant schema/data
    path and targeted Playwright glass check. The release lane refreshes live
    Atlas after every code/schema release and, after migrations, regenerates a
    live-catalog snapshot and blocks completion if it disagrees with committed
    `supabase/schema.sql`.
  - **After:** Bob returns a visible four-stage repair progress card and an
    exact Builder destination. The new inline `navigate_app` capability maps
    ordinary-language destinations to bounded admin routes for rostering,
    people/HR, clients, dispatch, finance, reports, documents, places, settings,
    approvals, and Builder; the destination page remains authoritative for
    role and module access, and business writes still use specific governed
    workflows. “Triage routed,” “Builder created,” “verified,” “merged,”
    “deployed,” “Atlas refreshed,” “schema checked,” and “glass-proven” remain
    separate receipt states.

  **Gate:** live `bob_messages` show no context-losing fallbacks; a Builder job
  runs implement → verify → repair without human touch and stops cleanly at
  `release_ready`; egress proven per rank; Atlas `exercised` is populated from
evidence, not asserted.

- **Tentative roster blocks and quotes from a written request (owner ruling,
  2026-10-20).** A staffing request is a set of date windows and shift patterns
  across one or more sites, not one 1–31 day window. `propose_roster_fill` only
  ranks staff into slots that already exist; it cannot create shifts. Bob now has
  `propose_tentative_roster_block`
  (`supabase/functions/bob-propose-tentative-roster-block`), which expands the
  request with a pure planner (`_shared/roster-block-plan.mjs`: NZ wall-clock
  times with daylight saving, unpaid breaks removed from paid and charged hours,
  hours split at NZ midnight so only holiday-day hours take the holiday rate,
  holiday list supplied and confirmed by the human) into ONE pending
  `bob_agentic_actions` proposal. Approval runs the service-only
  `apply_bob_tentative_roster_block`, which creates open, unpublished draft
  `roster_slots` (no staff; idempotent per action) and, when a client
  organisation is named, a draft `quotes` + `quote_lines` set. Every site must
  already resolve to exactly one active `roster_work_units` row; a missing site
  is reported, never guessed. Staff assignment and publication remain separate
  human steps. First-pass limits: break comes off the first midnight segment of a
  shift; one holiday multiplier applies to both pay and charge. Not yet proven
  end to end on a live approval.

- **Vehicle owners, record follow-ups and full-text activity search (owner
  ruling, 2026-10-20).** Vehicle profile facts are correctable by any
  organisation administrator with audited before/after and last-updated
  org/time (`20261020170000`). Owners are canonical people linked by
  `entity_links` owner edges via `record_vehicle_owner` (admin-only reads,
  NZTA restriction flag) (`20261020171000`); repeat-subject "owner identified"
  now honours those edges (`20261020172000`). Observations and patrol visits
  take appended `record_updates` (note, follow-up requested/resolved, H&S
  concern) and photos; Vehicle Search & Flags and the repeat-subject drawer show
  flagged / notice issued / H&S / open follow-up per observation
  (`get_observation_annotations`). Logged activity search runs server-side
  across every recorded field, appended updates, person and officer names and
  all dates (`search_activity_records`, trigram-indexed, same access
  predicates as table RLS). Repeat subject review is its own Reports tab.
  Not yet exercised by end users.
- **Vehicle owner access area and locality-only display (owner correction,
  2026-10-20).** Owner identity is the `vehicle_owner_identity` access area
  (direct grant or preset; administrators always), checked by
  `can_access_vehicle_owner_identity` in the owner RPCs and the `entity_links`
  owner policy; administrators switch it per user with the audited
  `set_vehicle_owner_access` checkbox in the user workspace. The owner reader
  returns suburb and town/city (`vehicle_owner_locality`) instead of the street
  address (`20261020180000`). Not yet exercised by end users.
- **Tiered owner details, vehicle people, sighting panel (owner correction,
  2026-10-20).** `get_vehicle_owner_links` redacts to locality for users
  without the owner area and returns full details (with address) for
  authorised users; `record_vehicle_person` adds drivers and associated people,
  optionally at a sighting (`20261020190000`). Observation history shows the
  first sighting photo (scan or attached evidence), opens the sighting in a
  right-side panel with a full-screen pop-out and send-to-investigation, and a
  flagged vehicle's profile carries a flag-coloured border and risk banner.
  Not yet exercised by end users.

## 10. Enterprise hardening (parallel track)

CI gates that actually block (unit + guard tests, migration snapshot drift, CSS
contracts); observability (error tracking, structured logs, alerting for a 24/7
dispatch system); DR with documented RPO/RTO and no single-VPS point of failure;
edge-function rate limiting; SSO/SCIM; compliance artifacts (Privacy Act
classification and retention confirmed by counsel); timestamped migration
discipline (already in place here).

## 11. What not to do (the recurring failure modes)

- No parallel place, org, status or evidence models inside a module.
- No per-module code branches where a data profile will do.
- No free-hand addresses; no silent geofence fallbacks.
- No hand-edited `schema.sql`; no Atlas edges asserted by hand; no "exercised"
  claims without evidence.
- No UI wired to a column nothing writes — use `ComingSoonPage` and say so.
- No Bob constraint without naming its rail or gate; no Bob write outside a
  governed, idempotent, audited path.
- No completion claims above the evidence: merged ≠ deployed ≠ glass-proven.
