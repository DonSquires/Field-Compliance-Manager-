# Bob enterprise agent architecture

Status: target architecture and staged acceptance contract. This document
implements, but does not outrank, [Bob doctrine](canon/BOB_DOCTRINE.md),
[Foundation](../FOUNDATION.md), the access canon, or the schema.

## 1. Decision

Bob remains **one agent** to the user: one identity, memory, conversation,
task ledger, governance loop, and experience across Operations, Studio and
Builder. Internally, Bob is an **evidence compiler**, not one unconstrained
language model.

A generative model may interpret evidence. It may not originate, silently
correct, or promote a high-risk identifier such as a numberplate, licence
number, person identity, access entitlement, or legal status. Deterministic
perception services produce candidates and receipts; Guardian gates disclosure
and effects; a human decides identity, legal, enforcement, and commercial
truth.

The target has seven cooperating planes:

1. **Experience** — Operations cockpit, Bob Studio, Builder Control Room, and
   result-in-habitat components.
2. **Orchestration** — Conductor, Oracle, Caddie, task ledger, memory and
   bounded specialist delegation.
3. **Perception** — OCR, ALPR, object detection, tracking, enhancement and
   document classification. These services return candidates, never verdicts.
4. **Evidence** — originals, derivatives, hashes, source locations, model and
   operation receipts, calibrated field confidence, conflicts and review state.
5. **Action** — proposals and governed, idempotent, audited RPCs.
6. **Builder/self-heal** — isolated plan, implement, test, review, repair and
   draft-release loops.
7. **Guardian** — server-owned tenant, rank, privacy, protected-path, evidence
   sufficiency, egress and effect gates outside model reasoning.

## 2. Why the present design failed

The observed NZTA example showed `JJJ739` in the source while Bob returned
`11739` and displayed `100% Confidence`.

### Before

Expected:

- The original NZTA image remains available and authoritative.
- OCR runs independently of language-model synthesis.
- The plate field has its own candidates, rules, provenance and review state.
- A standard NZ plate must match an accepted mixed alphanumeric shape.

Present before this repair:

- Generic document reading ran one whole-page Tesseract pass.
- The resulting text was sent to a general model.
- No field-level plate consensus or NZ standard-plate rule guarded the answer.
- Response/planner confidence was presented as bare confidence.

### During

Expected:

- Multiple OCR layouts produce independent variants.
- Labelled plate and query-entry locations agree.
- Invalid candidates are retained as conflict evidence, not promoted.
- Bob uses `[TO CONFIRM]` if the evidence gate does not pass.

Present before this repair:

- OCR character confusion was reproduced as prose.
- Generic Studio reading bypassed the stronger identity and ALPR contracts.
- No deterministic output guard prevented the wrong identifier.

### After

Expected:

- Structured extraction is persisted with the attachment.
- Studio shows field verification separately from response confidence.
- Canonical records receive only reviewed proposals through governed actions.
- Invocation receipts can later prove the capability was exercised.

Present before this repair:

- The prose looked authoritative, while the source-level field remained
  unverified.
- Atlas could show presence or wiring, but no sampled Bob capability had
  exercised evidence.

The immediate repair runs Tesseract page-segmentation modes 6 and 11, applies
NZTA plate-shape and cross-location consensus, guards model output, removes
unverified plate proposals, persists structured review state, and labels the
UI's percentage as **Response confidence**. This reduces one known failure
mode; it is not completion of the architecture.

The historical bad reply is also repaired without erasing audit history. The
original remains visible but is flagged and linked to an append-only correction
that states the source shows `JJJ739`, rejects `11739`, and requires source
comparison before identity promotion. BobPanel labels the two records
**Superseded by correction** and **Audit correction**. The idempotent,
timestamp-bounded repair creates no canonical vehicle, tenant vehicle or
observation.

## 3. Runtime roles and authority

| Role | Responsibility | Must not do |
|---|---|---|
| Conductor | Turn state, tool dispatch, rank/effect gate, egress, persistence | Delegate its server-owned gates to a model |
| Oracle | Truth state, safety state, proof grade and candidate effect | Convert weak evidence into a verdict |
| Caddie | Advertise Atlas-wired tools and their contracts | Select tools or claim exercise |
| Planner | Build a bounded plan and choose read/proposal actions | Assert source identifiers without a perception receipt |
| Working subagent | Perform a scoped read-only specialist task | Mutate tenant or production state |
| Verifier | Independently check claims, source alignment and effect safety | Approve protected effects |
| Guardian | Enforce rank, tenant, privacy, evidence and protected-path rules | Be bypassed by prompt wording |
| Builder worker | Edit and test in a disposable isolated checkout | Merge, deploy, change secrets, or write production data |
| Human reviewer | Decide identity, legal, enforcement and commercial truth | Be represented as having approved when no receipt exists |

## 4. Evidence contract

Every perception result must carry:

- source attachment and immutable original hash;
- derivative hash, if any, plus exact operations and parameters;
- provider, model/version, model-manifest signature and runtime;
- candidate value and normalized value;
- field or region coordinates and source frame/page;
- raw confidence and calibrated confidence;
- per-character confidence for OCR identifiers where available;
- independent variants and the consensus rule used;
- conflicts and rejected candidates;
- authority state: `candidate`, `verified_candidate`,
  `manual_review_required`, `human_approved`, or `rejected`;
- reviewer, decision time, reason and downstream promotion receipt.

Confidence is typed:

- **Response confidence** — planner confidence in its proposed response.
- **Field confidence** — perception confidence for one extracted value.
- **Evidence sufficiency** — deterministic rules showing whether the available
  proof can support the intended action.
- **Human decision** — an attributable approval or rejection receipt.

These values must never be collapsed into one percentage.

## 5. Perception and domain matrix

| Domain | Perception output | Required gate | Prohibited shortcut |
|---|---|---|---|
| NZTA/document OCR | Field candidates, locations, variants and source-time authority | Layout consensus, identifier syntax, source review | Model prose becomes canonical data |
| Numberplates | Vehicle crop, source/enhanced reads, per-character scores and multi-frame consensus | NZ syntax, minimum crop quality, conflict review | A sighting alone proves vehicle identity or stay |
| Face | Candidate match with threshold and evaluation context | Purpose, jurisdiction, consent/authority, retention and human review | Face match becomes legal identity |
| Person/body | Session-local track or re-identification candidate | Bounded session and disclosed purpose | Calling body similarity a named identity |
| Vehicle attributes | Make/model/colour/body candidates | Advisory display; plate or human evidence for canonical linking | Attribute similarity merges vehicles |
| Enhancement | Deterministic derivative and operation receipt | Original preserved; source/derivative disagreement reviewed | Generative detail treated as observed fact |
| Parking/freedom camping | Sighting sequence, location, duration and ambiguity | Continuous-stay and multi-visit rules, jurisdictional ladder | Enforcement from one plate observation |
| Access control | Candidate identity signal | Entitlement engine and current access policy | Recognition directly grants access |
| Smoke/noise/biosecurity | Detection or measurement candidate | Module-specific threshold, calibration and human/legal decision ladder | Detection directly creates a breach verdict |
| Welfare/safety | Risk signal and safety-floor warning | Least-disclosing warning and accountable follow-up | Suppressing a duty-to-warn signal because of tenant scope |

ALPR must prefer a vehicle-first crop, run original and deterministic enhanced
derivatives, use temporal consensus where video exists, retain raw and
corrected values, and fail to review on disagreement. Face evaluation must be
measured on relevant operating conditions and checked for demographic
differentials before tenant activation.

## 6. Desktop V2 as a local perception node

Desktop V2 already provides strong acquisition primitives: read-only card
discovery, recovery, hashing, resumable uploads, pinned FFmpeg, preview, local
review, marks, place assignment and receipts. It becomes a Bob perception node
only when it also:

1. verifies signed model manifests and records model digests;
2. runs bounded local inference without making authority decisions;
3. emits the same evidence contract as server inference;
4. keeps originals immutable and derivatives separately hashed;
5. queues receipts and review decisions through resumable, idempotent uploads;
6. proves real invocation to Atlas from accepted telemetry;
7. exposes a visible offline/provisional state and reconciles conflicts after
   reconnect.

Desktop capability presence is not wiring, and wiring is not exercise.

## 7. Experience specification

### Operations cockpit

- Show who is flying: Manual, Assisted, or Autopilot.
- Keep takeback visible and immediate.
- Place results in the operational page they belong to.
- Show source, field state, conflict and next safe action.
- Provide loading, empty, error, permission and partial-evidence states.

### Bob Studio

- Keep source preview and draft available together on desktop.
- Use a review drawer or tab on narrow screens.
- Put source verification above generated prose.
- Show exact candidates, rejected candidates, OCR method, source location and
  review requirement.
- Label planner percentage as **Response confidence — not field verification**.
- Never hide a persistence or extraction failure behind a successful answer.

### Builder Control Room

- Show the plan, changed terrain, worker boundary, tests, verifier findings,
  repair attempts and protected-path stop.
- Distinguish edited, tested, review-passed, draft-PR, merged, deployed and
  glass-proven states.
- Provide cancellation, rollback recommendation and durable receipts.

### Durable chat execution

- A browser turn receives a tenant-scoped durable request ID before planning.
- The conductor records the turn as `queued`, returns `202 Accepted`, and
  claims the queued run exactly once for background execution.
- The client polls the durable run rather than holding one long HTTP request or
  blindly resending after a timeout.
- Opening or reopening a conversation restores its newest queued, running or
  cancellation-requested run and resumes polling without enqueueing duplicate
  work.
- Queued requests cancel immediately. Running requests use cooperative
  cancellation at planner and tool boundaries.
- Completion replaces optimistic UI content from the canonical
  `bob_messages` transcript. Failure remains visible and recoverable.
- A request ID cannot be reused for different input, and status/cancellation
  remain scoped to the originating user, organization, conversation and
  workspace.

## 8. Self-heal and Grandmaster build loop

Self-heal is evidence-led repair, not direct production mutation:

1. Observe a reproducible failure and capture the exact redacted evidence.
2. Query schema and Atlas; keep `flow_reach` separate from `fk_reach`.
3. Reproduce in an isolated worker with a bounded acceptance test.
4. Prepare the smallest patch and directly related documentation.
5. Run focused tests, build, code review and security review where applicable.
6. Repair only from specific verifier evidence, with a bounded attempt count.
7. Publish a draft PR and stop at protected paths.
8. After human merge/deploy, run acceptance checks and recommend rollback when
   the measured outcome fails.

Bob may autonomously traverse implement, verify and repair inside the isolated
low-impact lane. Migration application, auth/RLS, secret or environment
changes, protected-branch merge, deployment and destructive bulk operations
remain human-turn-key actions.

## 9. Atlas and exercise evidence

Atlas refresh may establish `present` and static `wired` edges. It must never
declare `exercised` from code inspection. Exercise evidence must be generated
from accepted invocation telemetry and include:

- capability and caller context class;
- tool or RPC invocation identifier;
- start/end time and outcome;
- redacted evidence grade;
- environment;
- linked audit or test receipt.

Weak `references` edges are not reads or writes. A UI claim is live only when a
real schema/edge-function path and an invocation receipt support it.

### 9.1 Implemented: invocation-derived exercise (2026-09)

`scripts/atlas-exercise-evidence.mjs` (`npm run atlas:exercise`, `--apply` to
write) closes the exercise half of Phase F. It reads seven live invocation
sources — `bob_event_log`, `audit_log`, `builder_model_runs`,
`builder_worker_runs`, `bob_task_runs`, `bob_job_runs` and the perception
evidence tables — and resolves each receipt to a capability row.

Tool-to-edge-function resolution is **parsed at runtime** from the authoritative
`toolToEdgeFn` map in `supabase/functions/onspace-ai-chat/caddie.ts` rather than
duplicated, so the two cannot drift. Conductor-inline tools resolve to
`onspace-ai-chat` because they execute in the conductor's own dispatch switch.

Doctrine encoded in the script:

- `exercised = true` is written **only** where a counted invocation receipt
  resolves to a capability;
- `exercised = false` is **never** written — absence of evidence is not evidence
  of absence, so unproven rows stay `null`;
- evidence that resolves to no capability is reported as unresolved, never
  silently dropped;
- only the `exercised` column is patched. `scripts/atlas-refresh.js` always
  rewrites `notes` and `refresh_source`, so writing those here would cause
  perpetual churn between the two scripts.

Live result: **0 → 118 capabilities exercised** from 11,289 invocation
observations, with 0 unresolved evidence keys. Replay is idempotent, and a
subsequent static Atlas refresh was verified to preserve all 118 claims.

This work surfaced a real defect: `cancel_builder_job` is a registered,
admiral-gated conductor-inline tool but had no `toolToEdgeFn` entry, making it
invisible to terrain and exercise mapping. It is now mapped.

### 9.2 Still open: calibration

`scripts/perception-calibration-report.mjs` (`npm run bob:calibration-report`)
measures what the live review receipts actually support. As of the first run it
reports, and refuses to publish an accuracy rate because:

- `perception_model_calibrations` is empty — no model has a versioned
  evaluation receipt;
- no field carries a `calibrated_confidence`, so raw model confidence must not
  be presented as a probability of correctness;
- every domain sits below the 30-decision reviewed-sample floor
  (`cctv_vehicle_attributes` 4, `cctv_person` 25, `cctv_alpr` 6).

Across 705 candidate fields there are 35 human decisions (5.0% coverage): 29
upheld and 6 overturned. That 17.1% overturn figure is recorded as indicative
only and is explicitly **not** a published accuracy number.

## 10. Delivery sequence and acceptance gates

### Phase A — identifier safety

- Multi-pass OCR and deterministic field consensus.
- Fail-closed answer and proposal guards.
- Typed confidence and Studio source-review UI.
- Tests for valid, invalid and conflicting candidates.

Gate: the `JJJ739`/`11739` fixture cannot produce `11739` as a verified plate,
and no unverified plate reaches a proposed canonical entity.

### Phase B — shared evidence envelope

- One versioned perception/evidence schema across documents, CCTV and Desktop.
- Calibration records, source locations, derivative receipts and review RPCs.
- Verifier checks generated claims against structured tool evidence.

Gate: each high-risk identifier in prose resolves to a structured evidence
field with equal normalized value and sufficient authority, or the turn fails
to review.

**Implemented 2026-10-11 for the document-identity adapter.**
`perception_evidence_envelopes` records the immutable source hash and versioned
source/model/derivative receipts; `perception_evidence_fields` keeps candidates,
locations, conflicts and current authority; `perception_evidence_reviews` is
the append-only human decision history; and `perception_model_calibrations`
holds versioned evaluation receipts. NZTA document OCR now writes this envelope
replay-safely, and the deterministic chat verifier blocks plate claims that
exceed the structured authority. Raw receipt reads and review are
administrator-only until Phase C supplies domain-specific task-entitlement
policies. CCTV and Desktop adapters remain Phase C/D work; their existing
domain tables are not replaced.

### Phase C — perception adapters

- Bring ALPR, face candidates, person tracking, vehicle attributes, smoke,
  noise and biosecurity under the shared contract.
- Establish module-specific quality floors and human decision ladders.

**First adapter implemented 2026-10-11: CCTV ALPR.** Each plated CCTV entity
observation now compiles replay-safely into a `cctv_alpr` envelope after
source/enhanced derivatives are stored. The receipt preserves the original
evidence hash, frame location, raw/corrected OCR, model/provider provenance,
minimum character confidence, crop width, temporal consensus, derivative
hashes and conflicts. Machine verification requires every CCTV ALPR quality
gate; disagreement remains a candidate for review. The existing CCTV
observation decision is the sole human authority and is mirrored into the
shared append-only review history. Raw access remains administrator-only until
a task-entitlement policy is separately designed and tested. Vehicle-attribute
and vertical-module adapters remain Phase C work.

**Second adapter implemented 2026-10-11: CCTV person and face evidence.**
Person-presence, face-detected and pseudonymous portfolio candidates now compile
into replay-safe shared receipts without copying face or appearance embeddings,
candidate identity names or raw candidate records. New inference carries the
face provider, pinned detector/embedding model names, detector confidence, crop
width and deterministic alignment basis. Machine similarity is never
`verified_candidate` because relevant-condition and demographic calibration has
not been completed. The existing CCTV person-observation review remains the
only human authority; a shared identity reference is created only from an
explicit human link/new-identity action. Vehicle attributes and vertical-module
adapters remain Phase C work.

**Third adapter implemented 2026-10-11: CCTV vehicle attributes.** Make, model,
colour, body type and year now compile into replay-safe shared receipts with
source/frame custody, model/provider, crop, per-field confidence and derivative
hashes. Trained OpenVINO colour/type, heuristic fallbacks and unverified
vision-LLM make/model remain visibly distinct candidates; none can become
machine-verified or canonical. Plate identity acceptance no longer seeds any
visual attribute. The dedicated human vehicle-attribute review is the sole
promotion path and records confirmation, correction or rejection in the shared
append-only review history. Historical replay recorded 190 envelopes from 177
jobs; a second pass replayed all 190 without duplication. Vertical-module
adapters remain Phase C work.

**Fourth adapter implemented 2026-10-11: biosecurity photo classification.**
The governed submission now retains structured classifier provenance and
compiles species, density and threat-level candidates into `biosecurity_photo`
envelopes only when source custody is valid. Machine output remains advisory.
An explicit administrator review confirms, corrects or rejects fields and
appends shared review receipts; assessment workflow triage remains separate.
The oversight UI signs private evidence for short-lived display and shows
candidate confidence, model provenance and human authority state. The one
legacy linked evidence item fails closed as `missing_source_hash` on replay, so
no envelope is fabricated until custody is repaired. Smoke and noise adapters
were completed in the following slices.

**Fifth adapter implemented 2026-10-11: smoke photo classification.** The
governed officer receipt now preserves explicit source confirmation, notes and
structured classifier provenance before the service-only projection compiles
visible source, visual severity and visibility-impact candidates into
`smoke_photo` envelopes. Machine output cannot establish a statutory breach,
legal basis, notice or workflow closure. Separate administrator controls govern
photo classification, legal/operational action and workflow review; corrections
retain the original candidate as superseded evidence and append an attributable
review receipt. The responsive oversight UI signs private evidence for 15
minutes and exposes custody, model provenance, typed confidence, officer notes
and safe next actions. Desktop and mobile Chromium acceptance runs passed
without browser errors. All four legacy assessments lack evidence links; two
replays per record failed closed as `missing_evidence_link`, and a nonexistent
record raised `Smoke assessment is missing`, so no historical envelope was
fabricated. The mobile officer surface retains the governed submission receipt
after success and visibly separates the officer's source/action record from
Bob's advisory candidate, confidence, reasoning and model provenance. A missing
classification is shown as unavailable rather than replaced with a
success-shaped fallback, and the only named next step is separate supervisor
review.

**Sixth adapter implemented 2026-10-11: noise photo classification.** The
governed officer submission requires a private source/equipment evidence photo
while preserving the two-place complaint model and the officer's acoustic
matrix as the only statutory decision path. The service-only projection creates
advisory visible-source, equipment and visual-activity candidates in
`noise_photo` envelopes; a photograph cannot measure noise, estimate decibels,
determine excessive noise or authorize enforcement. Administrator photo review
is separate from acoustic, legal and workflow review, retains corrections as
append-only receipts, and cannot mutate matrix scores, action or notice fields.
The responsive oversight register uses cards at narrow widths and signs private
evidence for 15 minutes. Desktop and mobile Chromium capture/review acceptance
passed without browser errors. All 76 legacy assessments lack governed evidence
links; two replays per record returned `missing_evidence_link`, a nonexistent
record raised `Noise assessment is missing`, and no historical envelope was
fabricated.

Gate: source/enhanced disagreement and threshold failures never auto-promote.

### Phase D — Desktop V2 and offline operation

- Signed local model manifests, local receipts, resilient queue and conflict
  reconciliation.

Gate: offline results are visibly provisional, replay-safe and attributable to
the exact model and source.

### Phase E — Builder and self-heal

- Acceptance-test-first reproduction, specialist verification, bounded repair,
  draft PR, post-deploy acceptance and rollback recommendation.

Gate: a representative bug runs implement to `release_ready` without human
touch inside the worker, but every protected action remains blocked.

### Phase F — exercise and calibration

- Invocation-derived Atlas exercise data. **Implemented** — see section 9.1;
  live result 0 → 118 exercised capabilities.
- Accuracy, false-positive, false-negative, conflict and human-overturn
  dashboards split by model, environment and domain. **Outstanding** — the
  measurement script exists (section 9.2) and currently reports that the
  reviewed sample and calibration records cannot support any published rate.

Gate: no production-readiness or accuracy claim is made without a versioned
evaluation set and reproducible results. This gate is presently **unmet by
design**, and the calibration report says so explicitly rather than inferring a
rate from 35 decisions.

### Enterprise acceptance command

`npm run bob:enterprise-readiness` is the cross-domain Bob release gate. It:

- executes the original `JJJ739` versus `11739` failure as a direct acceptance
  check, including structured consensus, generated prose and proposed
  canonical entities;
- verifies that every declared implementation, authority document and
  acceptance test still exists;
- runs representative tests across Guardian/orchestration, document identity,
  CCTV/ALPR, enhancement, person/face, vehicle attributes, parking/freedom
  camping, access, smoke/noise/biosecurity, Desktop V2 and Builder/self-heal;
  and
- reports the present implementation state without promoting a known gap to a
  success-shaped result.

The machine-readable inventory and runner live in
`scripts/bob-enterprise-acceptance.mjs`. Its current result is five implemented
domains, five partial domains and no full gaps. Partial work is:

1. parking/freedom-camping shared-envelope projection and calibrated multi-visit
   ambiguity receipts;
2. access-control deployment, disposable-database validation, offline event
   sync and calibrated, purpose-bound tenant face/credential matching;
3. Desktop V2 signed local model manifests, offline receipts and conflict
   reconciliation;
4. consistent who-is-flying, takeback and result-in-habitat UX across modules;
   and
5. exercise/calibration — exercise is now proven from invocation receipts, but
   calibration records, calibrated confidences and a sufficient reviewed sample
   are all still missing.

The access-control source vertical now has a typed tenant event, custody links,
service-only receipt and perception projection, deterministic multimodal
recognition, and officer-first web/mobile workflows. Before the officer records
an outcome, face, person/body, vehicle and plate probes may rank organization-
scoped possible matches and show the probe beside available reference or prior-
sighting images. Discovery is not confirmation: the officer remains responsible
for identity, credential validity and the access decision, and recognition
cannot grant entry. The durable receipt independently reruns recognition from
the preserved image, excludes embeddings from client and stored receipts, and
projects ranked matches as review-required `candidate` fields rather than
canonical identities.

Contract, web/mobile TypeScript, Deno and production web-build checks pass. A
disposable Supabase Postgres database on the private Tailscale VPS route loaded
the live schema snapshot and migration, then exercised receipt/perception
idempotency, evidence custody, person/vehicle candidate projection, RLS, grants
and indexes. That execution found and corrected an ambiguous PL/pgSQL `id`
reference and an invalid perception `value_type`. The protected migration and
both access functions were then deployed through the linked Supabase project;
the migration ledger, Data API exposure and unauthenticated 401 boundary were
verified, and `supabase/schema.sql` was regenerated from the live catalog.
Deployment verification then found missing Edge Function inference bindings
and an older VPS image without `/infer/enhance`; the project secrets were bound
to the authenticated public inference endpoint, the previous image was tagged
for rollback, and only `fcm-inference` was rebuilt/recreated through the private
Tailscale route. Docker health, public HTTPS health, OpenAPI route presence and
authenticated route validation now pass. A real role-specific image workflow
is not yet glass-proven because no dedicated access-control test identity is
configured, and real-user credentials were not used as a substitute. `npm run
bob:enterprise-readiness:strict` therefore still fails intentionally while any
declared partial lacks its acceptance evidence. Grandmaster remains a
server-owned caller rank under ONE BOB; it is not a client-selectable BobPanel
mode and cannot grant Builder or operational authority.

## 11. Non-negotiable acceptance rules

- Original evidence is authoritative and immutable.
- Generative enhancement is interpretive and labelled.
- A model's confidence is never an approval.
- Missing and conflicting evidence stays visible.
- Identity, legal, enforcement and commercial decisions remain attributable to
  a human.
- Every write is tenant-scoped, authorized, idempotent and audited.
- Builder and self-heal cannot bypass protected paths.
- Presence, wiring, exercise and production proof are separate claims.
- Bob remains usable without autonomy; the human can always take back control.
