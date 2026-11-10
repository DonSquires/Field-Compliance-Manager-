# Freedom Camping and Parking Enforcement Audit

Date: 2026-11-10. Status: audit findings, not a repair or release approval.

Tracking: [issue #459](https://github.com/DonSquires/Field-Compliance-Manager-/issues/459). Related existing place-anchoring work: [issue #18](https://github.com/DonSquires/Field-Compliance-Manager-/issues/18). Open-issue title and exact-symbol searches were performed before creating the tracker.

## Scope and evidence boundaries

- Human observation: an attempted Freedom Camping job and Parking enforcement job both displayed an edge-function error.
- Production source pinned to `9a840255bf81b601f09945663b3c95f36b5289ae` (`origin/main`). The inspected scan pages, shared scan helper, scan/classifier/notice edge functions and private inference implementation are unchanged between that revision and this checkout.
- Inspected officer and standalone capture, mobile scan contracts, shared edge auth/receipts, ALPR/attributes/movement/watermarking, place/rule resolution, overnight/chalk persistence, evidence registration, breach actions, draft/print notice paths, oversight and history consumers.
- Live reads: bounded 24-hour function logs, deployed-function metadata, secret-name presence only, caller-scoped aggregate persistence/readiness, catalog types/grants, Atlas capabilities/direct edges/flow reach/FK adjacency.
- Private infrastructure credential: dedicated Codespaces SSH key. Supabase Management API token used only for diagnostics. Private inference/API tokens stayed inside their existing server containers. No credential values, identities, plates, GPS or private images are retained here.
- No production business writes, real-user login, impersonation, notice generation, external image transfer or credential changes. Private inference probes used generated synthetic images. In-memory edge probes used fake auth/database/network adapters.
- This is a bounded engineering audit, not a full legal review, a complete RLS proof, or field acceptance of every module mode. No real photo was replayed.

## Incident evidence

Observed UTC events on 2026-11-10:

| Time | Shared scan response | Duration | Correlated runtime warning |
| --- | --- | --- | --- |
| 07:36:04 | POST 400 | 8.295 s | Plate Recognizer HTTP 403 |
| 07:37:16 | POST 400 | 3.326 s | Plate Recognizer HTTP 403 |
| 07:37:37 | POST 400 | 3.106 s | Plate Recognizer HTTP 403 |
| 07:38:05 | POST 400 | 4.447 s | Plate Recognizer HTTP 403 |

These are correlated events for the shared `process-officer-scan` function, not an assertion that each timestamp belongs to a particular module. Request bodies were not collected. Earlier POST 401s on 2026-11-09 are separate evidence and not established as these attempts.

The inspected handler reaches Plate Recognizer before its final plate gate. A missing usable plate returns 400 with `A plate could not be confirmed from the photo. Capture a clearer image and try again.` The same sequence was reproduced in a synthetic execution of the handler. Thus the strongest supported immediate diagnosis is plate acquisition failing with its external fallback denied, not a proven database or geofence outage. The exact upstream reason for 403 (credential, account, permission, quota or supplier policy) remains unconfirmed. Existing local low-confidence output and real-image quality were not captured.

For the actor recovered internally from these executions, the scoped 24-hour read found zero new Freedom Camping observations, zero Parking chalk rows, and one scan request still `processing`. No partial primary records were found for these attempts. In the reachable organization/contract scope, 2 of 124 Freedom Camping zones and 1 of 1 Parking zone had active, verified geometry. Those counts do not prove rule, schedule, permission or exact selected-place readiness.

## Atlas and schema

Atlas reports `process-officer-scan`, `classify-parking-scene`, `motoweb-vehicle-lookup`, both compliance RPCs and both notice generators present/wired. `exercised` is null, not proof of execution or acceptance.

Directed flow reach from `edge_function:process-officer-scan`, depth 2, includes geofence/schedule/closure RPCs, canonical registries, request receipts, observations, overnight sessions, chalk, compliance matrices, breaches, evidence and audit. Direct callers include the two officer pages and the standalone/mobile scan surfaces. These are shared changes with cross-module effects.

Separate structural FK adjacency from `table:vehicle_overnight_sessions`, depth 1: observations, breach alerts, locations, Sites, Zones, organizations and observation-supporting evidence. This adjacency is not evidence that a workflow executes correctly.

Live catalog verification confirms both compliance evaluators are `SECURITY DEFINER` and executable by `authenticated`; their inspected bodies do not enforce caller/organization access. Overnight observation-link columns are nullable UUIDs. Request identity is globally unique; it is not bound to a payload fingerprint by the inspected handler.

## Findings: expected versus present

### A1 - High: shared ALPR failure blocks both modules, but the actionable error is hidden

**Before:** A mandatory evidence photo should enter a working ALPR path, with a governed manual fallback when no trustworthy plate is returned.

**During:** Local inference is tried, then Plate Recognizer for a missing/low-confidence plate. The recent fallback calls return 403. Officer pages throw the SDK invocation error without reading its HTTP response JSON, losing the server's useful diagnosis. Parking exposes no manual plate fallback; Freedom Camping does expose one.

**After:** The scan is not saved and the user sees a generic edge error. The user cannot tell supplier denial from image quality, auth, Zone or storage failure.

Evidence: [scan plate gate](../supabase/functions/process-officer-scan/index.ts#L836), [Parking submit](../apps/web/src/pages/OfficerParkingPage.tsx#L167), [camping submit](../apps/web/src/pages/OfficerFreedomCampingPage.tsx#L380). Synthetic handler returned the expected plate-failure 400. Next check: verify supplier authorization without production-photo transfer, and trace the configured edge-to-private-inference endpoint with a synthetic image. Do not equate private-container health with successful edge-network access.

### A2 - High: failed scans leave poisoned retry receipts; Parking lacks request identity

**Before:** A request ID must identify the same payload and permit safe retry without duplicate records.

**During:** `processing` is inserted before input/ALPR validation; ordinary 4xx/5xx returns do not finalize it. A retry within 15 minutes returns 409. Later recovery deletes a stale receipt and reruns the non-atomic pipeline. Completed responses are replayed without a payload match. Parking does not send `client_request_id` at all.

**After:** Correcting a manual plate can remain blocked; uncertain/partial saves can duplicate on rerun. The live actor scope contains one stuck receipt. Synthetic ALPR failure produced 400, then 409, with receipt still `processing`.

Evidence: [receipt lifecycle](../supabase/functions/process-officer-scan/index.ts#L767), [Parking payload](../apps/web/src/pages/OfficerParkingPage.tsx#L180). Acceptance: terminal/retryable failure receipts, immutable payload identity, resumable stages, concurrent retry tests, and an authorized recovery path; do not delete live receipts as a shortcut.

### A3 - Critical: service-role scan execution lacks a complete operational authorization gate

**Before:** Authenticated identity is necessary but active role, module and place/task authority must also be established; standalone mode has its own deliberate entitlement path.

**During:** The edge reads only profile ID/role/organization and elevates all database work to service role. Only `scan_operator` gets a module-entitlement check. Other roles are not allowlisted, deactivated profiles are not filtered, and active shift/provider organization is not carried through. Manual Zone validation is based on organization equality, which also rejects valid contracted client-owned Zones.

**After:** Server authorization is not equivalent to the UI's module visibility; unauthorized operational writes or valid contracted-place rejection are possible. No unauthorized production request was attempted.

Evidence: [shared auth](../supabase/functions/process-officer-scan/index.ts#L747), [manual Zone lookup](../supabase/functions/process-officer-scan/index.ts#L918). Acceptance: real database-role tests for allowed/denied callers, deactivated users, own/contracted/unrelated places, standalone mode and provider branches; preserve the distinction between record capture and enforcement authority.

### A4 - Critical: authenticated callers can invoke privileged compliance readers without tenant authorization

**Before:** Vehicle history/rule evaluation must require authorized organization/place/task context.

**During:** Both live compliance RPCs accept caller-supplied organization, Zone and plate; they run as definer and are granted to `authenticated`. Full inspected definitions lack caller-access enforcement. Parking returns previous chalk timing/repeat information; camping returns stay counts and certificate-related conclusions.

**After:** These are direct database disclosure paths independent of edge auth and RLS on the source tables. This audit verified grants/definitions, not exploitation against another tenant.

Evidence: [Parking evaluator](../supabase/schema.sql#L39856), [camping evaluator](../supabase/schema.sql#L32408). Acceptance: deny unauthorized direct RPC calls as actual database roles; either restrict service-only execution or implement the owning authorization contract with verified callers. Check blast radius before changing grants.

### A5 - High: low-confidence ALPR can still become the enforced plate

**Before:** A plate below the configured 0.75 confidence threshold should require human confirmation if fallback cannot produce a trustworthy result.

**During:** The threshold triggers fallback, but a failed fallback leaves the original low-confidence candidate in place. The final gate checks only whether its normalized text is nonempty.

**After:** The candidate can reach rules, records and breaches. Synthetic confidence 0.1 plus fallback 403 passed the plate gate. No production plate was used.

Evidence: [ALPR selection](../supabase/functions/process-officer-scan/index.ts#L836). Acceptance: low-confidence plus fallback denial never persists a confirmed plate without a recorded human decision.

### A6 - High: overnight pre-writes use invalid UUID placeholders and suppress database errors

**Before:** The evening/morning evidence pair and real source observation IDs must exist before their verification affects rule counts.

**During:** Both pre-compliance calls pass `observationId: ''` into UUID columns. Session helpers ignore insert/update errors. The two-photo post-phase reuses the old peek instead of reliably threading the actual inserted session ID. Existing-session paths increment observation counts in both phases.

**After:** A helper can report candidate/verified state without a saved session, compliance can use stale counts, and displayed counts can double increment. The synthetic helper reproduced a UUID rejection followed by `candidate_evening` and null session ID; live catalog confirms UUID types. This was not the cause of the recent requests, which stopped earlier at ALPR.

Evidence: [pre-write callers](../supabase/functions/process-officer-scan/index.ts#L1415), [session helper](../supabase/functions/process-officer-scan/index.ts#L325), [schema](../supabase/schema.sql#L8477). Acceptance: database-backed evening/morning, same-window repeat, concurrent retry, single-daily, movement and rollback tests using actual source IDs.

### A7 - High: identity/appearance similarity is treated as proof of stationary overnight presence

**Before:** Same vehicle and unchanged parking position are different claims. Conflicting/missing position evidence must remain inconclusive, not certify an overnight.

**During:** `/infer/compare` can leave the final confidence `same` when scene confidence is `changed`. The edge maps `same` to `stationary`. Private health says dedicated vehicle reidentification is not staged, while the pipeline still returns a 384-dimensional embedding.

**After:** Camping may promote a pair to `verified_overnight`; Parking may continue overstay evaluation without reliable movement evidence. Synthetic live comparison returned embedding similarity 1.0, scene similarity -0.999951, scene `changed`, final `same`.

Evidence: [comparison service](../services/fcm-inference/app.py#L869), [edge movement interpretation](../supabase/functions/process-officer-scan/index.ts#L242). Acceptance: explicitly separate identity and position decisions, reject conflicting scene evidence, require provenance/quality appropriate to the legal use, test same vehicle after moving and different vehicles in the same scene. Synthetic results are not an accuracy benchmark.

### A8 - High: Parking scene inference has broken integration and unvalidated outputs

**Before:** The authorized service caller must reach an available private vision capability, with validated schema/confidence and reviewable outputs.

**During:** The scan passes the service-role bearer to `classify-parking-scene`; the classifier instead requires `auth.getUser(token)` to return a user. Its legacy private API route returned authenticated 503 `capability_unavailable` to an empty synthetic probe. Parsed JSON is returned without a typed/range/confidence gate; parse failure becomes `success: true` with unknown fields. Failures are swallowed by the scan.

**After:** Classification can be absent while the scan proceeds, or unreviewed sign numbers can become policy input. The private API probe does not establish image-processing acceptance or prove the deployed classifier's configured URL is identical.

Evidence: [caller](../supabase/functions/process-officer-scan/index.ts#L1011), [classifier auth and proxy](../supabase/functions/classify-parking-scene/index.ts#L64). Acceptance: explicit service authentication, supported private vision route, real response-schema validation and unknown/review state on unavailable or low-confidence classification.

### A9 - High: Parking silently invents a clear verdict and lets OCR override governed rules

**Before:** Missing/erroring rule evaluation must produce unknown, and a captured sign interpretation must not silently overrule the verified source-backed rule.

**During:** The edge initializes `clear`, 60 minutes and 5 minutes grace; an RPC error leaves those values intact. The evaluator itself falls back to 60/5 and gives `p_sign_time_limit_minutes` priority over matrix and Zone rules without a confidence/human-review gate. It also runs when Zone resolution is not a verified match.

**After:** Missing rules, database errors or incorrect OCR can yield a seemingly valid return time/verdict, including outside configured geofences. Freedom Camping more honestly labels absent rules `unknown`, though its RPC errors are also ignored.

Evidence: [Parking default](../supabase/functions/process-officer-scan/index.ts#L1109), [rule precedence](../supabase/schema.sql#L39856), [governed signage authoring](../supabase/schema.sql#L57151). Acceptance: error/no-rule/no-Zone stay unknown; verified rule versions and human-approved changes travel with verdicts.

### A10 - High: repeated Parking scans can reset the clock and compare the wrong Zone

**Before:** Return checks must refer to the same parking event, place and first reliable timestamp; a new observation is not automatically a new chalk session.

**During:** Movement lookup selects the latest active record by organization/plate without Zone filtering. Every scan inserts a new active chalk; the evaluator subsequently selects the latest active chalk. Movement errors are not distinguished from affirmative stationary evidence.

**After:** Intermediate scans can reset the comparison baseline and miss real overstays; cross-Zone evidence can resolve the wrong prior chalk. No live chalk was mutated to test this.

Evidence: [prior chalk query](../supabase/functions/process-officer-scan/index.ts#L970), [chalk insert](../supabase/functions/process-officer-scan/index.ts#L1141), [evaluator](../supabase/schema.sql#L39856). Acceptance: first-seen versus return-observation model, same-Zone scoping, moved/reparked/inconclusive scenarios, stable idempotent retry.

### A11 - High: primary rows and evidence are not committed as one recoverable workflow

**Before:** Success must mean primary record, preserved photo, valid registration and linkage are confirmed, or an explicit recoverable partial state exists.

**During:** Primary inserts precede watermark/upload/registration. Watermark has no request timeout. Both storage upload results and later photo-link update errors are ignored. Registration can refer to an object whose upload was not confirmed. The browser converts images to resized JPEG before upload, so the path named `original` is not the original camera file and EXIF is not preserved by that conversion.

**After:** A thrown watermark/registration error may leave a row but return failure; retries may duplicate it. Some upload/link failures can still yield success. A claimed original/provenance chain is weaker than its label implies. No such partial primary row was found for the recent actor-scoped attempts.

Evidence: [capture conversion](../apps/web/src/lib/officerScan.ts#L134), [evidence storage](../supabase/functions/process-officer-scan/index.ts#L681), [registration](../supabase/schema.sql#L70822). Acceptance: checked upload/link receipts, bounded calls, retained original source plus derivative metadata, recovery across every failure point, no final success for missing required evidence.

### A12 - High: place, time and custody context can diverge from the job

**Before:** Captured coordinates, their provenance, capture time, provider branch, contracted client and selected specialty must agree; typed address is not proof of device presence.

**During:** Parking uses typed-address coordinates, not device GPS, and stamps `captured_at` on submit. Camping can replace GPS with an address while representing accuracy as zero. Both pages auto-select the current context Zone without checking that it matches the page module. The edge uses profile organization rather than active-shift provider, manual Zone equality rejects contracted client-owned Zones, and manual selection skips the resolver/client attribution. It selects the first sibling Site rather than recording an explicit place decision. Parking writes server-now and evaluates now; camping accepts historical captures but rule functions use current date and counters.

**After:** Correct evidence can be rejected or attributed to the wrong service/place/time; offline backdated decisions and reports can diverge from capture history. These are code-contract findings, not a claim that the user's exact selected Zone or GPS was wrong.

Evidence: [Parking payload](../apps/web/src/pages/OfficerParkingPage.tsx#L180), [camping address override](../apps/web/src/pages/OfficerFreedomCampingPage.tsx#L248), [edge place context](../supabase/functions/process-officer-scan/index.ts#L747). Acceptance: separate measured GPS/address/selection provenance, correct active provider and client custody, capture-time policy evaluation, specialty-matched selection and DST/offline tests.

### A13 - High: offline recovery can discard evidence after a server rejection

**Before:** Unsynced evidence must remain recoverable with an actionable rejected/pending state and a confirmed result before deletion.

**During:** Freedom Camping queue sync removes a scan on any non-network edge error, including the first 400/409; its message says removed after five attempts even for an immediate terminal failure. Standalone sync checks only invocation error, not the success receipt. Parking's officer page has no shared offline queue/request identity.

**After:** A user can lose the local queued photo without a saved record, or cannot recover consistently across entry points. This audit did not inspect or modify the user's IndexedDB.

Evidence: [camping sync](../apps/web/src/pages/OfficerFreedomCampingPage.tsx#L275), [standalone sync](../apps/web/src/shells/ScanShell.tsx#L196), [queue helper](../apps/web/src/lib/officerScan.ts#L205). Acceptance: rejected evidence quarantine, explicit retry/manual correction/export policy, honest attempt messages and receipt-verified removal.

### A14 - Medium/High: downstream notice and reporting semantics are not equivalent between modules

**Before:** Administrators and officers should see consistent source evidence, action authority, draft/issued state, durable artifacts and original rule/decision provenance.

**During:** Camping's action RPC checks source officer, active profile, place/task authority and workflow mode; print authorization has a separate typed-name/request receipt. Parking oversight offers `Issue infringement` from a chalk row, while its generator creates only a draft, accepts caller labels and does not establish an overstay/evidence gate before generating it. An active-draft unique constraint helps prevent duplicates, but the caller checks the chalk's legacy infringement-number field rather than loading the existing notice lifecycle. Camping also has hardcoded fee/legal defaults in its notice generator that require authoritative configuration review, not an assumption of legal correctness. Parking scan writes omit the `location_name` used by its history/notice display.

**After:** The user can confuse draft generation with issue, encounter a duplicate-draft error rather than reopen the draft, or see blank/unknown notice locations. A payment/appeal/service/legal-amount review and human notice acceptance remain outstanding; no real notice was generated here.

Evidence: [Parking oversight](../apps/web/src/pages/ParkingOversightPage.tsx#L86), [Parking draft generator](../supabase/functions/generate-parking-notice/index.ts#L109), [camping action gate](../supabase/schema.sql#L82999), [camping notice defaults](../supabase/functions/generate-notice/index.ts#L216). Acceptance: explicit draft/review/authorize/issue lifecycle, legal source configuration, existing-draft retrieval, evidence checks and downstream report/receipt tests.

## Private inference checks

Using existing server-side credentials in place, without exposing values:

| Check | Result | What it does not prove |
| --- | --- | --- |
| Private `/health` | ok; trained ALPR ready; vehicle model ready; reidentification model not staged | Edge URL/key parity, image accuracy or field acceptance |
| Synthetic `/infer/alpr` | HTTP 200; no candidate from deliberately synthetic image | Recognition quality for the reported photos |
| Synthetic `/infer` | HTTP 200; success; 384-dimensional embedding | Identity-grade/movement-grade semantics |
| Synthetic `/infer/watermark` | HTTP 200; valid JPEG bytes | Durable upload/registration/linkage |
| Synthetic `/infer/compare` | HTTP 200; conflicting scene `changed` and final `same` reproduced | A valid overnight verification |
| Authenticated empty legacy `/api/bob/vision` | HTTP 503; `capability_unavailable` | Correct image classification or edge-to-API route parity |

All relevant Supabase secret names are configured. Presence is not proof of valid upstream credentials or equality with VPS configuration. No secret values were fetched from the Supabase secrets listing.

## Verification and coverage

- 28 focused web unit/guard tests passed in six files: officer camping, officer Parking, Parking oversight, Parking rule governance, scan helper and camping statuses.
- 25 root contract tests passed: geofence P1 callers, mobile scan contract, officer Parking/place context and Parking notice numbering.
- Three independent synthetic edge probes reproduced A2, A5 and A6 using actual handler/helper source with fake network/database adapters.
- Live private synthetic probes established service availability and reproduced A7. They did not write tenant records or assess a private photograph.
- Existing Parking browser tests mock the entire `process-officer-scan` success response, including the 60-minute result. Passing them cannot establish a working ALPR, classification, compliance, storage or notice chain.
- No complete live successful scan, authorized rejection matrix, end-to-end evening/morning database test, offline device recovery, real-photo accuracy study, field legal-rule acceptance or printed-notice/service/payment lifecycle was executed. Do not call either module fully exercised.

## Smallest next moves and release gates

1. Restore a trustworthy plate-acquisition outcome: diagnose the supplier 403, verify edge/private inference parity with synthetic input, expose structured edge errors, require confirmation for uncertain plates, add Parking's fallback. Do not send private images to an external provider merely to test credentials.
2. Repair failure receipts and rejected offline-evidence retention before asking the user to retry; separate capture/evidence recovery from final success and bind request identity to immutable input.
3. Close the direct compliance-RPC authorization gap and complete server scan role/place/module authority, with actual database-role tests before production writes.
4. Repair atomic/recoverable evidence and overnight writes; refuse silent clear/verified outcomes on missing rules, failed persistence or conflicting movement evidence.
5. Repair Parking scene authentication/private capability, source-backed rule precedence and first-seen/return session semantics. Keep unknown/review states explicit.
6. Reconcile capture-time/place/client attribution and draft/issue/reporting contracts. Human acceptance must cover both modes/modules, desktop/mobile, a real authorized job, no-match/low-confidence supplier outage, wrong/unverified Zone, retries, evidence faults, moved/same/inconclusive vehicles, first scan/return, overnight pairs, history, approvals, notices and next-actor visibility.

Any implementation requires Atlas/schema recheck, focused executable regressions, disposable PostgreSQL authorization tests, protected PR/release handling and a post-release human retest. This report does not authorize credential rotation, clearing the stuck receipt, tenant-data repair or enforcement action.

## Local repair progress, 2026-11-10

The following changes are implemented locally, not deployed:

- Scan photos are staged in officer-scoped browser storage before submission. Rejected captures remain reviewable after reload on both officer routes and `/modules/freedom_camping` / `/modules/parking_enforcement`.
- The edge preserves/registers submitted photo evidence before ALPR. Plate rejection reports confirmed capture state; failed upload/registration never claims a confirmed saved capture. Primary photo uploads/link updates are checked and watermark requests are bounded.
- Failure receipts are retained and explicitly marked failed, bound to an input fingerprint, and safely retryable only before primary writes. Partial processing requires recovery rather than automatic stale-receipt deletion. Parking now has request identity, capture time and manual plate fallback. Low-confidence ALPR is not silently accepted.
- Active operational roles and caller-context owned/contracted place authority are checked. GPS resolution uses the authorized capture-time wrapper. A forward migration makes both privileged compliance evaluators service-only; actual database-role checks pass in disposable PostgreSQL.
- Parking requires a verified source-backed rule rather than inventing a clear/60-minute outcome. Failed rule evaluation is explicit, unreviewed OCR does not override the limit, same-Zone return evidence reuses the first chalk baseline, and unconfirmed movement/classification withholds overstay enforcement.
- Camping writes a real observation and photo linkage before one session write and policy evaluation. Session-write errors are explicit, the second count-incrementing upsert is removed, and an embedding match without matching scene evidence stays inconclusive.
- Location House > working-zone setup now includes Parking and Freedom Camping policy panels. Parking includes the posted limit, multiplier, grace, photographed sign and source. Camping includes consecutive/monthly limits, SCV requirement, source and wording. Saves are authorized, version checked, request-bound and audited. Current rules are written into the respective evaluator matrices; prior versions and advanced Camping fields are retained. The operating provider organization is explicit and authorized.

Verification: 2,325 web tests pass; 22 integrated desktop/mobile browser cases pass; 14 targeted runtime/PostgreSQL cases passed in the combined DB-enabled run, and the policy DB tests passed again after policy-matrix/scoping changes. TypeScript lint and production build pass. The complete root run exposed one stale resolver assertion, now corrected and passing, plus three failures in untouched catalog-identity/CCTV tests; do not describe the complete root suite as green.

Fresh human tests reported during repair still hit unchanged production: the recent read showed 400 followed by 409, stuck processing receipts and no new observation/chalk or scan-photo objects in the scoped paths. No real photos, receipts or attendance records were changed or reconstructed. Previous browser-only photos cannot be recovered from nonexistent server objects by this patch.

Still outstanding: supplier 403 account diagnosis/edge-to-private inference parity, restoration of the unavailable scene-classification capability, full task/module/provider-branch authorization acceptance, mobile-native offline recovery, capture-time/legal/notice lifecycle work, and real-device end-to-end human acceptance. No live credential rotation, tenant-data repair, migration application, deployment, commit or push was performed during this repair turn. The two forward migrations require the protected release lane, followed by regenerated live schema and Atlas refresh.

## Follow-up after PR #460, 2026-11-10

The initial repair was merged in PR #460 and the managed release lane applied its migrations. The follow-up starts from `f8d2d1a8d`; it does not edit or replay those migrations.

A fresh standalone Freedom Camping test still failed before record creation. The bounded database log identified the exact registration failure: `Court photo evidence requires inference watermark provenance and SHA-256 hashes`. The capture-first path uploaded raw bytes but omitted the metadata required by the live evidence trigger.

The follow-up repair, pending release:

- Registers original plus inference-watermarked evidence with both SHA-256 hashes before ALPR. One evidence item is then attached to the final observation/chalk with an audit event; manual plate confirmation reuses that item and request ID instead of uploading again.
- Uses the authorized operating organization for jurisdiction resolution and persistence, including branch module grants and canonical default operating context for callers without an explicit organization. A supplied operational agreement must be in date and linked to that provider, module and Working Zone.
- Preserves the current place model confirmed by the owner: organization jurisdiction provides organizational context; the House anchors the place; Site and Zone remain sibling facets; `zone_id` is the module-specific Working Zone, not a new nested entity. The House/Site context must agree with the selected Zone.
- Separates `device_gps`, `address_candidate` and `manual_zone`. Address coordinates never populate officer GPS evidence or establish presence/jurisdiction. Unmeasured presence and bounds remain unknown. An address candidate alone cannot submit a Parking report without a Working Zone.
- Retains source-less photos before returning a location-confirmation error. New mobile captures declare device GPS; legacy native queue entries without a source are held for review by the updated app. This is not a complete native recovery workflow or a deployed native-app acceptance claim.

Local verification includes 2,326 web unit tests, TypeScript lint and a production build; all six scan browser cases pass, including four officer/standalone reload-and-manual-confirmation routes. The five unchanged Location House policy/checkpoint cases passed in the preceding integrated run. Shared runtime, geofence and mobile contract checks pass; the disposable PostgreSQL role test also passes. Two stale root geofence assertions were updated. The three existing catalog-identity/CCTV failures remain unrelated and the complete root suite is not claimed green.

No new schema migration is required. No real-user session, production photo replay, receipt clearing or business-record repair was performed. Supplier authorization, unavailable scene classification, real-device/native acceptance, and the remaining legal/notice/reporting gates above remain open; the incident is not fully accepted until a fresh governed production scan confirms the evidence and record chain.

## Saved-capture recovery follow-up

After PR #462, human observation confirmed older saved captures still hit `scan_request_mismatch`. Review rebuilt the context using the current header, and pre-release fingerprints also included plate text, so retaining the image alone did not make those receipts replayable.

The follow-up adds an explicit **Recover saved capture** action. It retains the original saved context separately, without duplicating image bytes. The authenticated server verifies the original modern or legacy fingerprint, unchanged photo/time/coordinates/module, and a failed retryable pre-write receipt before atomically claiming the same request. Recovery is audited, including across audit-outage retries. Partial/completed/processing or unverifiable receipts remain blocked for operations review. No receipt is deleted or blindly reset.

Legacy fingerprints did not bind coordinate provenance, so their recovery requires a selected Working Zone and does not establish GPS presence. Original capture time and coordinates remain preserved. A manual plate correction can match the saved, currently confirmed, or originally blank plate variant without relaxing photo identity.

Verification: all 2,327 web tests, web TypeScript checks, and six officer/standalone browser cases pass. The runtime regressions cover successful legacy recovery, changed photo/time rejection, unproven GPS rejection, partial-write refusal and audit failure/retry. The real evidence-custody PostgreSQL contract also passes. This is code/test evidence, not proof that the user's two device-local captures have been recovered in production.

## First-snapshot and contracted-Zone correction

Further human testing still showed mismatched saved requests and an empty Parking Zone picker. Bounded actor-scoped live reads found three retryable registration failures, each with one storage object and no registered capture. Reachable scope contained two active verified Camping Zones and one active verified Parking Zone; none belonged to the profile's home organization. These counts establish availability in the inspected relationship scope, not correct location or operational authority for a particular capture.

Before: queue staging used an unconditional put, replacing the only saved payload on each retry. Camping also reacquired GPS whenever its history callback changed, including relationship refreshes. The module pickers narrowed Zones to an unrelated selected agreement or the profile home organization; a current Site could be inserted into an automatic module scan's context.

During: the correction preserves the first submitted context atomically in IndexedDB and refuses replacement photo/time/module/owner under the same request ID. Review restores the preserved coordinates; history refresh no longer reacquires GPS. Module Zone queries use the signed-in caller's existing RLS scope, active/module/verified filters, and retain server place checks. Known agreement/provider context is taken from the chosen Zone rather than the unrelated header. Recovery requires manual plate confirmation because older hashes included the entered plate; new captures retain automatic ALPR.

After: browser regressions assert the first snapshot exists before review, survives reload/retry on all four routes, requires a confirmed recovery plate, and offers module Zones when home/header-scoped queries return no results. Existing snapshots already overwritten before this correction cannot be reconstructed from their fingerprints. No original fingerprint, server receipt, storage object, boundary or business record was modified to force recovery; unverifiable historical attempts remain for operations review.