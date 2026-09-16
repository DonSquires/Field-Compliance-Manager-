# CCTV File System and Review Build Plan

## Purpose

Build a dedicated CCTV workspace inside the shared file system for ingesting source video, producing playable derivatives, reviewing machine-generated events, and promoting only human-confirmed observations into investigations, vehicle records, incident records, or evidence packages.

CCTV is not ordinary document storage. It is a time-based evidence workflow with large private media, derived files, asynchronous inference, uncertain recognition, chain of custody, and potentially sensitive face/vehicle information.

## Current implementation to preserve

- `bob-uploads` stores private source and playback media.
- `bob_attachments` records upload identity and processing state.
- `evidence_items` is the canonical evidence row with storage path, hash, capture provenance, retention, and court-ready lock.
- `inference_jobs` and `inference_results` provide the shared asynchronous inference queue.
- `register-desktop-video-import` and `register-bob-video-attachment` register video intake.
- `bob-perceive-video` and the vision workers produce derived motion/vehicle/face results.
- `CCTVReviewPage` provides job filters, signed playback, event timelines, keyframes, raw results, and manual face linking.
- Bob Studio exposes approved media review for permitted attachments.

The new build must improve this spine rather than create a second CCTV table or storage model.

## CCTV workspace experience

Route: `/admin/cctv` or the existing CCTV route inside Field Operations.

### Queue view

- filters: all, queued, processing, needs review, complete, inconclusive, failed
- search by source filename, camera/channel, evidence ID, job ID, incident, site, zone, vehicle plate candidate, and reviewer
- filters for capture time, upload time, site/zone, domain, sensitivity, and retention state
- cards show source, duration/file size, processing state, derivative state, event count, review count, and chain-of-custody status
- no result is presented as a confirmed fact until a reviewer confirms it

### Review view

- signed playback player with a visible source/derivative label
- timeline with motion segments, vehicle candidates, face candidates, and reviewer markers
- click an event to jump playback to its timestamp
- keyframe strip with hash, timestamp, source frame, and review state
- tabs for consolidated events, keyframes, and bounded raw inference JSON
- side panel for site/zone/camera context, source metadata, processing receipt, retention, and linked records
- actions: mark reviewed, reject candidate, assign person record, confirm vehicle observation, create/link incident, add evidence link, export evidence package, and request reprocessing

### Human review states

Every event and identity candidate must support:

- `unreviewed`
- `accepted`
- `rejected`
- `uncertain`
- `needs_more_context`
- `superseded`

The UI must distinguish “model saw a candidate” from “human confirmed an observation.”

## CCTV file-system spaces

| Space | Contents | Access |
|---|---|---|
| CCTV Intake | Original H.264/H.265/MP4 uploads and upload receipts | Uploader plus CCTV administrators |
| CCTV Playback | Remuxed or transcoded playable derivatives | Same organisation scope; signed URLs only |
| CCTV Derived Frames | Keyframes, thumbnails, hashes, and worker outputs | CCTV reviewers and authorised investigators |
| CCTV Review Packages | Human-selected clips, frames, notes, and review decisions | Review participants and evidence custodians |
| CCTV Exports | Court/report/investigation evidence packages | Explicit recipient scope; immutable after sealing |

Derived objects must retain `source_evidence_id`, `source_job_id`, `source_hash`, `relative_timestamp_seconds`, and `created_by_worker` metadata. A derivative is never treated as an independent source.

## Required data-model additions

### `cctv_sources`

Represents a camera or import origin:

- organisation, site, zone, camera/channel reference
- source system, timezone, retention policy
- active state and source configuration metadata
- owner and audit timestamps

### `cctv_media_assets`

Represents source and derived media around one evidence item:

- `evidence_item_id`, asset kind (`source`, `playback`, `thumbnail`, `keyframe`, `clip`)
- storage bucket/path, MIME type, byte size, SHA-256, duration, frame rate, codec
- parent asset, remux/transcode status, worker run ID
- creation and deletion/retention state

### `cctv_review_events`

Represents human decisions over machine events:

- inference result/event ID, event domain, timestamp range
- review status, reviewer, notes, confidence override
- linked vehicle/person/incident/investigation/evidence IDs
- immutable decision audit fields

### `cctv_exports`

Represents a selected evidence package:

- source event/keyframe/clip references
- export purpose, recipient scope, legal hold, approval state
- generated artifact path, manifest hash, generated-by, approved-by
- sealed/issued timestamps and download audit

All tables must be organisation-scoped, RLS-protected, append-only where decisions are historical, and linked to existing `evidence_items` rather than duplicating evidence identity.

## Inference and media lifecycle

1. **Receive** source upload or desktop import.
2. **Register** Bob attachment and canonical evidence item with source hash.
3. **Validate** MIME, size, path ownership, tenant, source user, and duplicate hash.
4. **Remux/transcode** unsupported elementary streams into a playback derivative.
5. **Queue** bounded inference jobs for motion, vehicle, face, OCR, or other approved domains.
6. **Produce** results, keyframes, thumbnails, hashes, and provisional face/body portfolio profiles. An unrecognised person receives a canonical `Unknown Person #N` profile; the model does not verify a name or make a consequential identity decision.
7. **Review** machine candidates in the CCTV workspace.
8. **Name or enrich** the existing provisional person profile after human review; link or merge it with other canonical person records only with human evidence.
9. **Package** selected media and decisions into a manifest-hashed evidence export.
10. **Seal** only after required human/legal approvals; lock before release.

## Safety and privacy controls

- Never expose storage service-role credentials in the browser.
- Use short-lived signed URLs and do not place raw storage paths in public links.
- Enforce tenant and operating-branch scope at every query and signed URL request.
- Face/body inference may create or reuse a provisional canonical person profile (`Unknown Person #N`) and attach its observations to that profile. It remains `manual_review_required`; no model supplies a verified name.
- ALPR candidates retain confidence and review-required state; low-confidence text is not a confirmed plate.
- No model output may create an enforcement case, notice, disciplinary action, or a verified/named person identity without approval.
- Face/vehicle exports require explicit purpose, recipient, retention, and approval.
- Support legal holds and prevent deletion of sealed source or derived evidence.
- Redact or restrict thumbnails when the viewer lacks face/vehicle evidence permission.
- Record every playback/export/download and every identity or vehicle decision.

## Bob capabilities

- `bob-cctv-list`: list permitted sources, jobs, media assets, and review state.
- `bob-cctv-search`: search source metadata, event timestamps, filenames, sites, zones, and linked records.
- `bob-cctv-preview`: provide bounded playback metadata, keyframes, and cited event windows.
- `bob-cctv-summarise`: summarise reviewed events only, clearly separating machine candidates from confirmed facts.
- `bob-cctv-propose-review`: prepare a review queue with uncertain candidates and missing context.
- `bob-cctv-propose-link`: suggest incident, vehicle, person, or investigation links with source evidence.
- `bob-cctv-propose-export`: prepare a selected evidence package and manifest for approval.
- `bob-cctv-reprocess`: request a bounded retry when a derivative or inference job fails.

Bob must not identify a person, confirm a plate, issue an enforcement action, or export CCTV evidence without the relevant human approval.

## Sample-data acceptance cases

The live/sample CCTV import pattern already demonstrated by the repository must be covered by fixtures:

- source H.264/H.265 files remain viewable as source assets while conversion is pending
- remuxed MP4 playback appears automatically when evidence metadata receives `playback_storage_path`
- completed motion inference shows events and keyframes
- uncertain ALPR candidates remain marked for review
- face candidates can be manually assigned to an existing person record only through the governed RPC
- source, playback, and derived frame hashes appear in the review context
- failed, inconclusive, and unavailable feeds do not render as empty successful results
- mobile and desktop review layouts do not hide the player, timeline, or approval controls

## Implementation phases

### Phase 1: strengthen the existing review surface

- Add source/derivative metadata, hash, duration, codec, and processing receipts to the review page.
- Add explicit event review state and reviewer notes.
- Add robust loading, unavailable, conversion, failed, and empty states.
- Add desktop/mobile E2E flows for playback, timeline jump, keyframe review, and manual face assignment.

### Phase 2: media asset and review-event schema

- Add `cctv_sources`, `cctv_media_assets`, and `cctv_review_events` migrations with RLS and append-only decision history.
- Backfill existing `evidence_items` metadata into media assets without changing source identity.
- Add Atlas edges for source, asset, inference, review, and export paths.

### Phase 3: governed links and evidence exports

- Link accepted events to vehicle/person/incident/investigation records through commands.
- Add selected-clip/keyframe export with manifest hash and approval gate.
- Add legal hold, retention, download audit, and sealed export receipt.

### Phase 4: operational hardening

- Add queue retry visibility, worker health, stuck-job detection, and idempotent reprocessing.
- Add size/duration limits and resumable import handling.
- Run seeded CCTV workflows against the real deployment and record exercised Atlas evidence.

## Acceptance criteria

1. A reviewer can find CCTV by source, site, time, job, event, or linked record.
2. Source and playback assets are visibly distinct and traceable to one evidence item.
3. H.264/H.265 conversion states are explicit and never appear as broken or empty playback.
4. Motion, vehicle, and face results show confidence and review state.
5. No face or plate candidate becomes authoritative without human confirmation.
6. A reviewer can jump from an event to its playback timestamp and keyframe evidence.
7. Confirmed events can be linked to an incident or investigation with audit provenance.
8. An approved export includes selected media, source hashes, result hashes, review decisions, and an immutable manifest.
9. Tenant, role, HR/legal, retention, legal-hold, and signed-URL controls pass negative tests.
10. Desktop and mobile walkthroughs pass for upload/import, conversion, review, rejection, linking, and export approval.