# Biosecurity Governed Module Design

Date: 2026-09-03
Status: implemented; photo-perception adapter verified 2026-10-11

## Decision

Implement biosecurity assessment capture as one authenticated, idempotent edge-function command named `submit-biosecurity-assessment`. The command owns admission, evidence custody, database receipt, and audit. Web and mobile call this command; neither writes `biosecurity_assessments` or calls `capture-environmental-evidence` directly.

A server-side command is the selected boundary because a SQL RPC cannot atomically control object storage, watermarking, and image inference. The command uses a database receipt transaction for the authoritative record and a deterministic evidence path based on the organization and client request ID. It returns success only after the assessment, its evidence record, and audit event have committed.

## Domain Invariants

- The authenticated active officer determines the organization and officer identity. Clients never supply either as authority.
- The observed source place (`site_id`, `location_id`, `location_name`) is distinct from the threatened protected land (`protected_land_site_id`, `protected_land_address`). The two may match or the protected-land anchor may be unknown.
- One client-generated UUID identifies one submission. Retrying it returns the original receipt and never creates a second assessment or evidence record.
- The required photo is captured, watermarked, stored privately, hashed, and recorded before the assessment can be confirmed.
- AI classification is evidence enrichment, not a legal or enforcement decision. It cannot set `species_confirmed`, issue a notice, or create an MPI referral.
- An officer-recorded direction or infringement requires a notice number. An MPI referral requires its referral number. The command records an existing authority reference; it does not invent enforcement authority.
- Every successful submission writes one append-only audit event with the assessment ID, request ID, evidence IDs, action, and place anchors.

## Five Approaches Investigated

| Approach | Reuse | Assessment | Decision |
| --- | --- | --- | --- |
| 1. Direct browser insert plus evidence function | Current `OfficerBiosecurityPage` | Simple, but creates an assessment before evidence is known to exist. Atlas shows the two calls as separate edges. | Reject. This is the bolt-on failure mode. |
| 2. SQL RPC only | `submit_officer_field_report` | Provides auth, validation, idempotency, and audit in one transaction, but cannot safely own binary upload, watermarking, or inference. | Reject as the outer boundary. Reuse its database receipt semantics. |
| 3. Reuse `process-officer-scan` as-is | Scan evidence pipeline | Strong media handling, but its vehicle/observation/compliance contract is not a biosecurity assessment contract. | Reject. Reuse the custody techniques, not the endpoint. |
| 4. Create an independent biosecurity app or queue | Historical prototype | Would duplicate session, evidence, offline, policy, and workflow state outside the SaaS spine. | Reject. It reintroduces a parallel module architecture. |
| 5. Governed edge-function command with a database receipt | `process-officer-scan`, `submit_officer_field_report`, `officer_command_requests`, `evidence_items`, `module_rule_sets` | Separates cross-service evidence work from the short authoritative transaction while keeping one client command, durable idempotency, and precise failure states. | Select. |

## Command Contract

`POST /functions/v1/submit-biosecurity-assessment`

Request fields:

- `client_request_id`: UUID generated once at capture time and retained by web/mobile retry queues.
- `assessed_at`: device capture time.
- `source_place`: optional `site_id`, `location_id`, `location_name`, GPS, and address context.
- `protected_land`: optional `site_id` and address, deliberately independent from source place.
- `assessment`: species, density, seed-head status, land-use context, scene description, action, notice or referral reference, and follow-up state.
- `evidence`: one or more image payloads with capture metadata. The initial UI may submit one image, but the contract is an ordered array.
- `dispatch_job_id` and `shift_id`: optional workflow context that must belong to the officer's organization and assignment.

Receipt fields:

- `assessment_id`, `command_id`, `created`, and `received_at`.
- `evidence`: immutable evidence IDs, storage paths, SHA-256 digests, device capture timestamps, and watermark versions.
- `classification`: `pending`, `available`, or `unavailable`; never a confirmation of species or enforcement.
- `review_state`: `submitted` or `requires_supervisor_review`.

Failure fields:

- `code`, safe user-facing message, `client_request_id`, and a retry classification: `retryable`, `correctable`, or `terminal`.
- A failure before the database receipt is not an assessment submission. Orphaned storage is marked for cleanup by the command and is never exposed as evidence.

## Server Workflow

1. Authenticate the bearer token and load an active officer profile. Derive organization, officer, role, and module entitlement server-side.
2. Validate request shape, capture-time window, place IDs, assignment/dispatch context, density/action combinations, notice/referral references, and organization module rules from `module_rule_sets`.
3. Lock or create an `officer_command_requests` row for `client_request_id` and command type `biosecurity_assessment_submit`. A completed row returns its stored receipt. A running row returns retry-safe in-progress state.
4. Validate image count, MIME type, byte limit, and capture metadata. Use deterministic private object keys containing organization ID and client request ID.
5. Generate a watermark containing capture time, source/place context, officer ID, request ID, and watermark version. Upload original and watermarked assets, calculate SHA-256 digests, and retain the custody metadata.
6. Run classification as a bounded enrichment step. Classification failure does not erase stored evidence; it returns `unavailable` and opens supervisor review rather than asserting an unverified species.
7. Invoke a dedicated SECURITY DEFINER receipt RPC. In one transaction it inserts the assessment, inserts `evidence_items`, writes an ordered `biosecurity_assessment_evidence` link, projects legacy `photo_urls` during migration, appends `audit_log`, and saves the exact response in `officer_command_requests`.
8. Compile an available structured classification into the shared perception envelope through the service-only writer. Writer failure is explicit after the authoritative receipt; retrying the same client request repairs the missing projection without duplicating the assessment.
9. Return the stored receipt. Retries after a timeout read the command row and return the same assessment/evidence IDs.

## Schema Changes

Keep existing assessment columns additive and preserve the current protected-land contract. Add:

- `biosecurity_assessments.client_request_id UUID NOT NULL` and a unique index on `(organization_id, officer_user_id, client_request_id)`.
- `biosecurity_assessments.evidence_state TEXT NOT NULL DEFAULT 'pending'` with values `pending`, `verified`, `unavailable`, and `rejected`.
- `biosecurity_assessments.review_state TEXT NOT NULL DEFAULT 'submitted'` with values `submitted`, `requires_supervisor_review`, `triaged`, and `closed`.
- `biosecurity_assessment_evidence` link table: organization ID, assessment ID, evidence item ID, ordinal, purpose, and creation timestamp. This avoids treating JSON as the only evidence relationship.
- A uniqueness constraint on `officer_command_requests` for organization, command type, and request ID, after checking current production data for duplicates.

`photo_urls` remains as a compatibility projection while existing readers migrate to the link table. It is not the source of truth for new capture paths.

## Photo Perception and Review

The deployed `biosecurity_photo` adapter preserves the complete classifier
receipt (candidate, details, reasoning, confidence, classifier, provider,
model, and prompt version) and compiles species, density, and threat-level
candidates into the shared perception envelope. Machine output remains
`candidate` or `insufficient`; it never becomes `human_approved` by confidence
alone.

`review_biosecurity_photo_classification` is the only field-level authority.
An organization administrator may confirm, correct, or reject the candidate
with required notes. Corrections preserve the machine candidate as
`superseded`, append an attributable review receipt, and project only the
approved species/density to the assessment. The review function does not
change notice or MPI referral fields. Operational triage through
`manage_biosecurity_assessment_review` remains a separate workflow decision.

The oversight page signs private `scans` evidence for 15 minutes and presents
the image, custody state, candidate fields, typed machine confidence, model
receipt, and separate classification/workflow controls. Missing or unavailable
classification remains visibly review-required rather than becoming a
success-shaped fallback.

### Verified production state, 2026-10-11

- **Before:** two assessments and one linked evidence item existed. The linked
  legacy item had no canonical SHA-256 or watermarked SHA-256 value.
- **During:** the service-only writer was invoked twice for that link. Both
  calls returned `missing_source_hash`; no envelope or field authority was
  created. A nonexistent assessment was rejected.
- **After:** structured assessment columns and the review/writer RPCs are live,
  Atlas reports the biosecurity command and shared writer path as present and
  wired, and Atlas still makes no `exercised` claim. Eligible future
  submissions can compile replay-safely; the legacy item remains an explicit
  custody-repair gap.

## Governance and System Integration

- Atlas: query capability and direct edges before migration; add executable calls/reads through the command, then regenerate Atlas rather than hand-editing graph rows.
- Caddie: may describe the biosecurity command when it is Atlas-wired. It does not decide whether the command runs.
- Conductor: is the gate for Bob-initiated calls. It supplies caller, scope, and effect checks before invoking the same command; no separate Bob write path exists.
- Oracle: records truth state for confidence, proof grade, classification availability, review requirement, and external-reference completeness. It does not grant notice, referral, or species-confirmation authority.
- RLS: clients retain read access only. Revoke direct authenticated inserts and updates once both web and mobile use the command and supervisor transitions have their own governed RPC.

## Review and Downstream Workflow

The officer command creates `submitted` records. A separate supervisor transition RPC uses expected-state locking and audit provenance to move records through `requires_supervisor_review`, `triaged`, and `closed`. Formal notices, referrals, task assignment, and external MPI integration remain separate governed commands linked by assessment ID. They are not side effects of photo classification or initial capture.

## Delivery Sequence

1. Recheck Atlas capability/edges, migration ledger, and current schema immediately before coding.
2. Add schema, receipt RPC, constraints, RLS adjustments, and contract tests.
3. Add the edge function and evidence-custody tests, including retry after every external step.
4. Replace the web page's direct insert and evidence call with the single command.
5. Confirm the command is exercised in a controlled environment, refresh Atlas, then add the mobile panel using the same request/receipt contract and durable retry queue.
6. Add the supervisor review RPC and migrate readers from `photo_urls` to linked evidence.

## Acceptance Tests

- A valid capture produces exactly one assessment, audit event, command receipt, evidence item per image, and ordered evidence link.
- Replaying the same request before, during, and after a client timeout returns one stable receipt with no duplicate objects or rows.
- An upload, watermark, or receipt failure never returns submission success and leaves no readable evidence without a record.
- Classification failure yields `unavailable` plus supervisor review, while evidence custody remains complete.
- Cross-organization IDs, inactive officers, non-entitled modules, invalid place/assignment relationships, missing notice/referral references, and malformed GPS are rejected.
- The source and protected-land anchors may be equal, different, or unknown without being conflated.
- Direct browser insert is rejected after cutover; web/mobile have only the command call edge.
