# File System and Sample Data Build Plan

## Outcome

Give every authorised user a dependable file system for finding, opening, reviewing, classifying, approving, linking, and producing documents. The file system must preserve tenant boundaries, HR/legal confidentiality, evidence integrity, source provenance, retention, and human approval.

The sample corpus in `Build-Plan/sample data` is the acceptance corpus. It contains 40 files across contracts, service agreements, site instructions, attendance, incidents, LINZ reporting, certificates, HR/legal correspondence, pay costing, invoices, finance, branding, and evidence.

## Governing rules

1. **A file is not automatically a business record.** Upload and extraction create a quarantined source; promotion requires a human decision or an existing governed command.
2. **One file system, policy-scoped spaces.** Users should not need separate applications for organisation, HR, evidence, finance, and Bob files, but they must see only spaces allowed by role, organisation, operating branch, case, and legal hold.
3. **Bob proposes, humans approve.** Bob may classify, extract, compare, summarise, link candidates, and prepare drafts. Bob must not silently create a contract, credential, invoice, disciplinary outcome, or compliance decision.
4. **The source remains inspectable.** Every extracted field and generated output must link to document, version, page/cell/paragraph evidence where available, model run, reviewer, and decision.
5. **Duplicates are safe.** Hashes, source identity, and tenant scope must deduplicate bytes without losing upload events or provenance.
6. **Sensitive material is not broadly searchable.** HR/legal, medical, disciplinary, affidavit, and formal employment records require a restricted space and explicit access audit.
7. **Evidence is immutable when sealed.** Existing `evidence_items`, court-ready locking, retention, and audit contracts remain authoritative for evidence.

## Target user experience

### File System home

Route: `/admin/files` for administrators and `/client/files` for client-scoped users.

The first screen is a dense, searchable workspace rather than a marketing page:

- global search across permitted filenames, extracted text, tags, source references, and linked records
- spaces: **Organisation**, **Contracts**, **Sites and Operations**, **HR and People**, **Finance**, **Evidence**, **Investigations**, **Bob Intake**, and **Generated Outputs**
- filters for owner, organisation, branch, document type, status, date, expiry, sensitivity, review state, and linked entity
- clear states: quarantined, extracting, needs review, approved, superseded, sealed, expired, held, failed
- preview pane for PDF, image, DOCX text, spreadsheet sheets, extracted fields, citations, and version history
- actions: download, open source, compare versions, assign reviewer, link record, request extraction, approve promotion, reject, supersede, apply hold, and generate output

### Human review workspace

Every extracted candidate is reviewed in a two-pane view:

- left: original document/page/sheet
- right: extracted fields and proposed links
- each field shows confidence and source location
- reviewer can accept, edit, reject, or mark unknown
- promotion explains the exact governed RPC that will run
- receipt shows created/updated records, skipped duplicates, warnings, and audit ID

### File-specific spaces

| Space | Examples from sample corpus | Access and actions |
|---|---|---|
| Organisation | logo, goals, policies, insurance certificates | Org admins; classify, version, publish reference |
| Contracts | service agreements, supply agreements, terms, proformas | CRM/commercial roles; extract parties, places, terms, rates, obligations |
| Sites and Operations | assignment instructions, handouts, attendance templates | Operations/roster roles; produce site briefs, work units, patrol/dispatch templates |
| HR and People | COA applications, affidavits, emergency appointments, disciplinary letters | HR/legal roles only; restricted search, legal hold, correspondence workflow |
| Finance | pay costing, invoice costing, expense reimbursement | Finance/commercial roles; extract lines, reconcile, approve, generate invoice/reimbursement |
| Evidence | photos, CCTV, incident attachments, reports | Evidence/operations roles; hash, retain, seal, link to incident/investigation |
| CCTV Review | source video, remuxed playback, motion events, vehicle/face candidates, keyframes | CCTV reviewers and authorised investigators; see [the CCTV build plan](CCTV_FILE_SYSTEM_BUILD_PLAN.md) |
| Investigations | incident reports, review letters, affidavits, evidence packages | Investigation participants and authorised reviewers; immutable event timeline |
| Bob Intake | unclassified uploads and source URLs | Uploader plus authorised reviewers; quarantine until promoted |
| Generated Outputs | report packs, letters, agreement drafts, site briefs, evidence exports | Output owner and permitted recipients; version, approval, delivery receipt |

## Existing schema to reuse

- `bob_attachments`: private intake metadata and extraction state.
- `documents`: canonical document registry, storage reference, tenant scope, and discoverability.
- `document_versions`: extracted text, effective dates, supersession, and extraction confidence.
- `document_upload_events`: immutable upload provenance, including deduplicated uploads.
- `evidence_items`: shared evidence store, hashes, retention, court-ready lock, and capture provenance.
- `retention_policies`: retention defaults by organisation/module.
- `audit_log`: action provenance.
- `entity_links`, `investigation_links`, and existing CRM/HR/finance relations: links from files to business records.

## Schema additions required

Add these through migrations only after Atlas blast-radius review:

### 1. File spaces and folders

`file_spaces`

- `id`, `organization_id`, `space_key`, `name`, `sensitivity`, `default_retention_class`, `active`, timestamps
- unique `(organization_id, space_key)`

`file_folders`

- `id`, `space_id`, `parent_folder_id`, `name`, `folder_key`, `policy_json`, timestamps
- unique sibling name/key within a space
- no cross-organisation parent links

### 2. Canonical file placement and permissions

`document_placements`

- `document_id`, `space_id`, `folder_id`, `placed_by`, `placed_at`, `is_primary`
- a document may have one primary placement and governed secondary links

`file_access_grants`

- `organization_id`, `space_id`, optional `folder_id`, optional `user_id`, optional `role`, `access_level`, `reason`, effective dates, audit fields
- HR/legal grants must be explicit; inherited organisation access is insufficient

### 3. Classification and extraction review

`document_classifications`

- `document_id`, `document_version_id`, `document_type`, `sensitivity`, `classification_confidence`, `classified_by`, `review_status`, timestamps

`document_extraction_runs`

- `document_version_id`, extractor/model, prompt/version, status, confidence, extracted_payload, source_map, started/completed timestamps, error

`document_promotion_reviews`

- `document_id`, proposed_action, target_type, target_id, proposed_payload, source_map, status, reviewer, decision notes, timestamps

All writes to business tables must still use existing or new governed RPCs. These tables store proposals and evidence, not an unrestricted generic writer.

## Bob capabilities

### Intake and retrieval

- `bob-file-list`: list permitted spaces, folders, files, versions, and review states.
- `bob-file-search`: search permitted filename, extracted text, metadata, and linked records with citations.
- `bob-file-preview`: return a bounded text/page/sheet preview and source locations.
- `bob-file-compare`: compare versions and identify changed clauses/fields.
- `bob-file-classify`: propose document type, sensitivity, retention, and destination space.

### Extraction and promotion

- `bob-file-extract`: run format-specific extraction for PDF, DOCX, XLSX, and image/OCR sources.
- `bob-file-review`: create a human review package with confidence, missing fields, and source citations.
- `bob-file-propose-promotion`: prepare an existing governed RPC call, never execute high-impact promotion silently.
- `bob-file-promote`: execute only an approved promotion and emit a receipt.
- `bob-file-generate`: create a versioned draft agreement, letter, site brief, invoice, report pack, or evidence package from approved source data.

### Domain-specific extractors for this corpus

- agreement and supplier contract extractor
- site instruction and attendance-template extractor
- credential/certificate extractor
- incident/LINZ weekly report extractor
- pay-costing/invoice/expense extractor
- HR/legal correspondence and disciplinary-case extractor
- image/evidence metadata and hash extractor

Each extractor must emit a common envelope: `document_id`, `version_id`, `document_type`, `fields`, `source_map`, `confidence`, `missing_fields`, `warnings`, and `proposed_links`.

## Implementation phases

### Phase 0: safety and corpus preparation

- Add the sample corpus to a controlled test fixture, not production storage.
- Exclude the empty fax placeholder, Office lock file, and diagnostic binary.
- Hash every source and create a manifest with sensitivity classification.
- Confirm retention, legal-hold, and access policy with the product owner.
- Add negative tests for cross-tenant and HR-space access.

### Phase 1: read-only file system

- Add file-space navigation, search, preview, version history, and download receipts.
- Reuse `documents`, `document_versions`, `document_upload_events`, and `bob_attachments`.
- Add storage signed-URL service and audit events; do not expose service-role storage access to the browser.
- Add desktop/mobile responsive walkthroughs.

### Phase 2: classification and extraction review

- Add quarantine state, classifier, extractor adapters, source maps, confidence, and review queue.
- Support PDF/DOCX/XLSX/image previews.
- Process the sample corpus in a disposable test tenant.
- Require explicit review before any promotion.

### Phase 3: domain promotion

- Contracts: promote parties, agreement, sites, modules, terms, and rates.
- Operations: promote site briefs, work units, patrol/dispatch templates, and attendance fields.
- Credentials: promote certificate/application candidates with expiry review.
- Finance: promote pay-costing, invoice, and expense candidates with reconciliation.
- HR/legal: promote restricted cases and correspondence with legal hold.
- Incidents/reporting: promote incident, observation, follow-up, and report-pack inputs.

### Phase 4: generated outputs

- Add approved templates for agreement drafts, review letters, disciplinary invitations, site briefs, invoices, monthly reports, and evidence packages.
- Store every output as a new document version with source references and approval receipt.
- Add send/download controls with recipient, timestamp, and delivery audit.

### Phase 5: Atlas and operational proof

- Register all file-system routes, components, RPCs, edge functions, tables, and storage edges in Atlas.
- Add expectations such as `file upload -> extraction run -> review -> governed promotion`.
- Exercise each promoted sample-data workflow in a seeded tenant and record `exercised` evidence.
- Add schema-dump drift and managed-migration coverage checks.

The CCTV-specific lifecycle, review states, media derivatives, and safety gates are defined in [CCTV_FILE_SYSTEM_BUILD_PLAN.md](CCTV_FILE_SYSTEM_BUILD_PLAN.md).

## Acceptance criteria

1. A user can find a permitted file without knowing its exact folder.
2. A user can open PDF, image, DOCX, and XLSX content in a reviewable preview.
3. A user can see source, version, hash, owner, sensitivity, retention, links, and audit history.
4. HR/legal files are invisible to users without explicit access.
5. Bob can classify and extract a sample file but cannot silently promote it.
6. Human approval promotes valid fields through governed domain commands.
7. Duplicate uploads preserve the upload event and point to the canonical document.
8. Generated outputs retain their source documents and approval chain.
9. Sealed evidence cannot be edited or deleted before retention expiry.
10. Desktop and mobile walkthroughs cover upload, review, promotion, rejection, search, and download.
11. Atlas shows the full file workflow and exercised records distinguish static wiring from proven runtime use.

## Delivery order

1. Build the read-only file system and policy model.
2. Add sample manifest, quarantined fixture loader, and extraction review queue.
3. Implement agreement/certificate/incident extractors first because they connect to existing CRM, compliance, and reporting paths.
4. Implement finance and HR/legal extractors behind restricted roles and approval gates.
5. Add generated outputs and delivery receipts.
6. Complete Atlas wiring, E2E walkthroughs, security review, schema-dump refresh, and release approval.

Current implementation boundary: approved `crm_agreement` proposals now execute through an idempotent, explicit-input command that requires provider, client, name, dates, validates the active client, records source provenance in `service_agreements.external_refs`, and audits the result. The remaining target types (`credential`, `finance_reconciliation`, `hr_case`, `site_brief`, and `investigation_link`) still require their own target-specific commands and validation contracts before execution is enabled.