# Connected Bob engineering delivery plan

Recorded 2026-10-25 following owner approval to record, track and proceed.
Authority: [Bob doctrine](canon/BOB_DOCTRINE.md), under
[FOUNDATION](../FOUNDATION.md) and the access model. This is an implementation
plan, not a change to approval, privacy, spending or release authority.

## Outcome

One Bob with shared knowledge, evidence and continuity. Builder chat understands,
investigates and coordinates. Vibe supports interactive fullstack iteration.
Builder supports durable autonomous implementation, recovery and delivery. Both
execution modes can hand off revision-bound work without restarting discovery,
losing edits or creating duplicate jobs.

Retain the existing coordinator, autopilot, workspaces, checkpoints, verification
and release lane. Connect working implementations rather than adding another
parallel orchestration system. Models choose hypotheses and useful tools; hard
boundaries enforce authority, provenance, privacy and consequential actions.

## Baseline evidence

- Builder chat has repository, Atlas, aggregate and job-ledger tools, but not
  the platform diagnostics, knowledge retrieval and memory available elsewhere.
- Live platform metadata: 208 active embedded knowledge cards, including eight
  Builder/Vibe cards. Card existence does not prove retrieval by Builder chat.
- Dedicated test-owner reads: VPS viewer health succeeds, but assessment and
  Docker services return 404. Vercel health and deployment reads succeed.
- No Hostinger connector was found in inspected implementation paths. SSH does
  not establish hPanel access.
- Public cloud image/document/web research passed live acceptance. Documents
  currently use private extracted text, not native document originals.
- Private investigation remains inadequate. A mechanically accepted diagnostic
  proposal cited a real quote that did not establish the claimed live cause.
- Original missing release-source repair remains open. Do not supply Bob its
  solution or count a proposal/commit/PR as a verified repair.

These observations are dated evidence, not permanent health assertions.

## Delivery checklist

- [x] Record this plan and establish tracked tasks.
- [ ] 1. Repair diagnostics and connect governed capability discovery.
- [ ] 2. Connect relevant knowledge retrieval and durable task evidence.
- [ ] 3. Improve investigation quality and honest planning states.
- [ ] 4. Implement bidirectional Builder/Vibe handoffs.
- [ ] 5. Measure model fit, recovery and resource efficiency.
- [ ] 6. Verify connected delivery through actual UI workflows.

### 1. Usable capabilities

Repair existing diagnostic routes before adding alternatives. Reuse server-side
implementations and expose callable contracts with purpose, authority,
environment, availability and evidence semantics. Distinguish implemented,
configured, reachable and successfully verified. Credentials remain in adapters.
Include VPS, Docker, Supabase, GitHub, Vercel, browser, backend, web and network;
Hostinger requires a separately governed official API connector.

Gate: enabled capabilities are discoverable and usable from their intended lane.
Missing configuration, denied access and unreachable routes are distinguishable.
Health alone never establishes that a downstream operation works.

First implementation slice (not yet released): shared read-only source/Docker
diagnostics, capability discovery and complete tool contracts are wired into the
private Builder chat lane and authenticated Docker-view routes. Relay fallback
uses separately paired legacy/control-plane credentials only after missing routes;
authorization failures do not trigger credential fallback. Metadata excludes
environment values, commands, logs and mounts. Vibe/engineer injection remains
pending until their external-model handoff and historical-context paths enforce
the diagnostic data's private-compute boundary. Do not silently disable their
existing authorized cloud behavior or leak operational evidence into it.

Validation of this slice: 83 focused Node tests passed, including successful
authenticated route tests with a hermetic Docker fixture, denied worker/model
credentials, tool contract checks, relay credential pairing and chat regressions.
Syntax and diff checks passed. An in-memory, read-only probe inside the existing
VPS control-plane container successfully ran source assessment and selected Docker
inventory for all 16 containers. The image source's Git revision was unavailable
and was not asserted. This probe neither replaced production modules nor deployed
the branch, and is not proof of a live UI turn or repaired edge relay. Atlas
generation was dry-run only; no schema, credentials or live map were changed.

Release follow-up: PR #220 merged and deployed at
`6be75e55ab2f6cd9f6e32b0dd1e6f69274d3f8d5`. Actual edge acceptance still
returned 404: the public nginx allowlist omitted every assessment/Docker alias.
An authenticated internal route and a deployed tool are insufficient evidence
of public reachability. Add the exact diagnostic aliases to managed nginx and
test them as part of relay-path coverage; all handlers retain admin authentication.
Do not mark the relay repaired until dedicated test-owner live reads succeed.

### 2. Shared relevant context

Reuse approved card retrieval and memory. Keep canon, task evidence and experience
notes distinct. Retrieve relevant context at start and at direction changes.
Preserve source/version references, uncertainties and invalidation after changes.
Do not silently promote experience notes into authoritative knowledge.

Gate: continuations recall decisions and failed approaches without repeating
answered questions; stale evidence is recognized, not reused as current proof.

First stage-2 slice: ordinary private Builder chat turns automatically retrieve
relevant active platform-canonical cards before reasoning and record the actual
retrieval receipt; status-only and public-research turns do not preload them.
Builder chat can also retrieve cards again as the investigation changes,
using the existing 768-dimensional embedding/match path, re-read scoped provenance
and return version/hash/truncation receipts. An explicitly degraded bounded keyword
path remains available if private embedding fails. Thread-scoped tool receipts
persist bounded result text, revision, time and failures for continuation reads;
historical results do not satisfy fresh source-investigation gates. No tenant
cards, in-app conversation or diary are shared. Vibe/Builder integration and
cross-mode handoffs remain subsequent work, not implied by chat-only delivery.

Stage-1 delivery evidence: #220 and proxy follow-up #221 are merged; governed
release `e4a5049130ea069651537cf084dd6fbbe3c32a07` passed actual dedicated
test-owner edge reads (assessment 200, Docker inventory 200). The live UI
acceptance invoked the new diagnostic successfully but also made refused and
repeated calls, then ended with an error after model timeout. Capability
reachability is proven, useful end-to-end model completion and efficiency are not.

Stage-2 probe: a real private embedding request hit its 15-second deadline under
the current runtime workload. The explicit degraded keyword path returned relevant
continuation/discovery cards with provenance; semantic retrieval was not proven.
Do not hide this degradation or claim vector quality from fixture tests. Initial
full runtime validation passed 1,715 tests with nine existing skips.

### 3. Evidence-supported investigation

Cancellation recovery follow-up: the private Chat client enforces a shorter
turn deadline than the gateway's inference deadline. Source inspection found
that a disconnected model-run HTTP caller did not cancel upstream inference,
leaving the local provider occupied during fallback. Propagate response-close
cancellation to the upstream fetch, including body consumption; release the
existing serial guard only when that invocation unwinds. Caller cancellation
must not poison provider health or count as a planning timeout. This fixes a
specific resource-lifecycle defect, not tool-loop reasoning or model competence.

Owner clarification after #224: Atlas is a map, not evidence. It identifies
where to research; facts require investigation of those locations. The live
`bob_atlas_blast_radius` card retrieved during acceptance still said "PROVEN
DATA FLOW", contradicting that distinction. Correct the shared runtime guidance,
Atlas tool receipts and four directly related canonical cards, invalidating
their old embeddings. Preserve flow/FK separation without promoting either
map into proof. Keep map leads, independently verified facts and unknowns
separate; unchecked areas stay unverified.

Carry goal, observed behavior, evidence, hypotheses, unknowns, proposed change,
blast radius and before/during/after acceptance into the handoff. Deterministic
checks establish provenance and shape; bounded independent critique challenges
causal support. A model critic is not proof. Reproducible checks outrank opinion.
Support explicitly exploratory work when the cause is unknown rather than
forcing an invented repair plan.

Gate: unsupported claims are rejected or qualified, while adequate investigations
proceed without a human supplying the technical solution.

Atlas-guided research slice (2026-10-25, pending release): Chat, Builder and Vibe
now share navigation guidance: discover entity names, use direct edges and
source-file evidence to choose reads, follow the relevant upstream/downstream
blast radius, inspect security controls, and keep flow, weak references and FK
structure distinct. A platform-canonical card makes the same method retrievable.
This is not a task-specific repair recipe or a fixed sequence for every question.
Simple guidance answers need no repository investigation.

Stage-2 live follow-up: #222 deployed at
`c3bac5004873ae33d6227b190b0116714d6e612c`. The actual UI acceptance retrieved
platform-only cards through vector matching with provenance and no degradation,
then made 13 unrelated source reads and failed instead of answering the guidance
question. Vector reachability is proven; semantic usefulness and completion are
not. The selected cancelled job was present in background context, but its causal
role in the drift is unproven.

Two bounded, non-persistent private-model probes tested current-request framing
and a tool-result reminder. Both still failed: the first wandered into guessed
investigation UI files; the second repeatedly read canon. The latter also used
explicit keyword degradation after private embedding failed and retrieved less
relevant cards. Each used a 180-second investigation budget and 35-second turn
deadline, not the production defaults; neither is a successful end-to-end test.
Provider recovery hit the existing local-serving guard; it was not weakened.
A third probe loaded all three changed runtime modules into the isolated process,
including the shared Atlas lesson (the first two used the deployed engineer/Vibe
imports). It also failed after repeated canon reads and provider recovery.
The protocol fix constrains the actual final structured schema, rather than
only removing native tools. Regression tests cover ordinary/proposal final
schemas, current-request priority, and the shared Atlas lesson. These changes
must not be reported as a proven fix for model task focus or the original repair.

Pre-release validation: 1,722 runtime tests passed with nine existing skips
using four concurrent test files. An initial unconstrained run failed its
control-plane startup fixture; that fixture passed in isolation and in the
bounded full run. The prompt-version assertion was updated for Vibe v17.
The new 2,313-character card fits Chat's 2,500-character per-card limit.
Schema cross-check of `bob_atlas_flow_reach` confirms direction means stored
edge traversal, not business impact: downstream is source-to-target and upstream
reverses it. In particular, a table reader is upstream of its table. The shared
lesson and card teach that distinction rather than equating downstream with
every affected consumer. The focused follow-up suite passed 108 tests.
Migration inventory reports 712 unique versions; Atlas generation was dry-run
only (1,517 capabilities, 8,788 edges). Release and live acceptance remain
separate evidence gates.

### 4. Cooperating execution modes

Extend existing task/session/job records only where necessary. Handoffs preserve
owner intent, accepted decisions, identifiers, base/head revisions, branch,
evidence, existing edits, verification results, outstanding work and holds.
One active writer per workspace; parallel work uses separate branches and an
explicit integration step. Choose execution mode by interaction needs, not by
frontend/backend labels.

Gate: handoffs in both directions preserve work and avoid duplicate jobs,
conflicting edits, repeated discovery and contradictory completion claims.

### 5. Measured efficiency

Benchmark tool correctness, discovery, evidence-supported diagnosis, implementation,
recovery, visual/document interpretation, elapsed time and inference consumed per
verified outcome. Route by demonstrated fit within current data/spending authority.
Reuse valid results, run focused tests, resume checkpoints and retry only after a
material change. Separate infrastructure recovery from engineering revision;
queue scarce GPU/browser resources.

Gate: compare completion rate, repeated calls, elapsed time and cost with baseline.
Do not weaken hardware guards or call model availability engineering competence.

### 6. End-to-end proof

Acceptance set: original release-source fault; desktop/mobile UI change; backend
persisted outcome; cross-stack workflow; interrupted recovery; genuine access or
human-decision fork. Before: authority, environment, revision and starting state.
During: useful checks, bounded recovery and honest progress. After: verified
changes, release identity, runtime/persisted result and downstream behavior.

Gate: completion requires the requested outcome, not a proposal, branch or PR.
Retain receipts and reviewed lessons. Never seed the tested fault's solution.

## Approval decision held separate

Recommended future behavior: investigate means research; plan means stop at a
plan; explicit build/fix means an isolated job within scope, with protected
consequences retaining their gates. Current Builder chat requires Create job.
This plan does not remove that gate. Record an explicit dated canon ruling
before changing it.

## First milestone

Builder chat independently obtains live evidence for the original fault and
produces a defensible next action without the supervising engineer supplying the
solution. Release changes through normal PR/CI and governed deployment; refresh
Atlas from real code and regenerate schema only if the live catalog changes.
