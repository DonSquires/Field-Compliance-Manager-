# FCM Enterprise Security and Good-Practice Design

Status: design baseline, not a legal certification
Owner: FCM product and engineering team
Date: 2026-09-11

## Purpose

Field Compliance Manager must support defensible security-services delivery across New Zealand organisations, clients, sites, zones, workers, dispatch, evidence, documents, finance, and governed administration. The product must make it possible to answer:

- what happened;
- where and when it happened;
- who acted and under which authority;
- what risk, hazard, or duty was involved;
- what evidence supports the account;
- who reviewed or approved the result; and
- what remains unresolved.

This document turns the external good-practice material and the repository's platform doctrine into a build and assurance baseline. It does not claim that software alone makes an organisation compliant, or replace competent legal, health-and-safety, privacy, employment, or security advice.

The companion interaction and information-architecture specification is [Bob and FCM Enterprise UI/UX Design](BOB_ENTERPRISE_UI_UX_DESIGN.md). It defines how these controls appear in the operating surfaces and document workspace.

## External source baseline

The following sources are the current research inputs. Each source remains subject to its own scope, currency, copyright, and professional interpretation.

- [NZSA Security Services Good Practice Guidelines](https://security.org.nz/wp-content/uploads/2023/04/NZSA-NZ-Security-Services-Good-Practice-Guidelines_April-2023.pdf), produced with E tu, WorkSafe New Zealand, and NZCTU. Retrieved 2026-09-11.
- [NZSA Guidelines, Codes of Practice and Standards](https://security.org.nz/security-industry-good-practice-guideline/), retrieved 2026-09-11.
- [NZSA Part 6A Good Practice Guideline](https://security.org.nz/wp-content/uploads/2026/07/NZSA-Good-Practice-Guideline_Part-6A-of-the-Employment-Relations-Act-2000.pdf), retrieved 2026-09-11.
- [WorkSafe New Zealand](https://www.worksafe.govt.nz/), for Health and Safety at Work Act 2015 guidance and approved guidance material.
- [Office of the Privacy Commissioner New Zealand](https://www.privacy.org.nz/), for Privacy Act 2020, information privacy principles, breach response, and privacy-by-design guidance.
- [New Zealand Protective Security Requirements](https://www.protectivesecurity.govt.nz/), where government or protective-security customer requirements apply.

The NZSA guideline is operational good-practice guidance. It specifically covers leadership, governance, employment standards, risk management, health-and-safety management, worker engagement, uncertainty, communication, factual decision making, continual improvement, accountability, competent advice, commitment, and auditing. Its operational sections cover customer/site onboarding, staff training and deployment, site safety, supervision, working alone, customer communication, record keeping, reporting, technology, and incident/emergency practice.

## Design principles

1. **One shared truth spine.** Organizations, branches, clients, agreements, places, staff, work, evidence, documents, finance, and audit remain the owning abstractions. Bob does not create parallel identities, sites, or compliance records.
2. **Governed commands at the write boundary.** Browser and mobile surfaces call an authenticated Edge Function or SECURITY DEFINER RPC for consequential work. A successful command atomically records the domain result, evidence links, audit event, and idempotency receipt where applicable.
3. **Evidence before conclusion.** AI classification, extraction, similarity, risk scoring, and drafting are provisional. They never silently establish legal, identity, enforcement, employment, financial, or safety truth.
4. **Human control is explicit.** Every high-impact output has a named reviewer, rationale, expected-state check, approval timestamp, and immutable audit receipt.
5. **Tenant and purpose limitation.** Data is visible by organization, branch, role, case, place, legal hold, and purpose. Sensitive material is not broadly searchable merely because it exists in storage.
6. **Uncertainty is a state.** Unknown, not_found, could_not_verify, provisional, needs_review, blocked, stale, and superseded are first-class outcomes.
7. **Source remains inspectable.** Generated fields and claims link to document/version and page, paragraph, cell, evidence item, event, model run, or other source location where available.
8. **Fail closed at action level.** A loading, error, missing entitlement, missing evidence, or ambiguous authority state must not expose a consequential action as available.
9. **Operational accessibility.** Desktop and mobile flows preserve context, next action, safe fallback, status announcements, keyboard access, readable text, and no horizontal clipping.
10. **No certification theater.** FCM provides controls, records, workflows, and evidence. It does not display a generic compliance badge or imply that a customer is compliant without a reviewed evidence basis.

## Control domains

### A. Governance and accountability

Expected controls:

- organization and branch context visible on every management workflow;
- named owner for hazards, incidents, plans, documents, actions, and reviews;
- management review and continual-improvement queue;
- immutable audit events for consequential actions;
- board/client reporting based on factual records, not model prose;
- competent-advice and escalation fields where the matter exceeds the operator's authority.

FCM mapping:

- `organizations`, operating-organization context, agreements, places, staff, `audit_log`, Bob event log, approvals, task runs, and report packs.
- Bob's role is to assemble evidence, identify gaps, and prepare a reviewable artifact.

Gap to close:

- Add an explicit management-review / continual-improvement workflow linked to incidents, audits, corrective actions, and document revisions.

### B. Risk, hazards, and site safety

Required document/workflow families:

- customer/site onboarding risk assessment;
- site safety plan;
- hazard register and control review;
- pre-deployment and pre-start checklist;
- change-of-site or change-of-service risk review;
- residual-risk acceptance with competent owner;
- review and expiry schedule.

Required fields:

- organization, client, agreement, site/zone, activity, worker groups, hazards, existing controls, proposed controls, residual risk, emergency actions, consultation evidence, owner, review date, source references, and approval.

FCM mapping:

- `organizations`, `service_agreements`, `client_sites`, `location_zones`, workforce/readiness, dispatch, evidence, documents, retention, audit.

Bob boundary:

- Bob may draft a risk register from approved site instructions and incident history. A human must accept controls and residual risk.

### C. Incidents, emergencies, and corrective action

Required workflow:

1. Report incident or near miss with time, place, people, work, and immediate actions.
2. Preserve evidence and prevent alteration after sealing.
3. Triage severity and notification requirements.
4. Investigate contributing factors and root causes.
5. Assign corrective/preventive actions with owners and due dates.
6. Review effectiveness and close only with evidence.
7. Feed lessons into site plans, training, and management review.

Required states:

`reported -> triaged -> investigating -> actions_open -> effectiveness_review -> closed` plus `blocked`, `held`, and `reopened`.

Bob must not close an incident, assert a root cause as fact, or decide notification authority without the governed review path.

### D. Workforce, training, deployment, supervision, and welfare

Required document/workflow families:

- role and competency matrix;
- induction and pre-deployment checklist;
- site-specific briefing acknowledgement;
- training and refresher record;
- supervision log;
- working-alone / remote-work plan;
- welfare check and escalation record;
- fatigue/fitness-for-work acknowledgement;
- worker consultation and representation record.

Required controls:

- eligibility and credentials checked before deployment;
- supervisor and escalation owner visible;
- active shift, location, safety, and welfare state kept separate from HR identity truth;
- worker-raised hazards and feedback receive an owner, status, and response receipt;
- no AI inference can certify competency or fitness for work.

FCM mapping:

- workforce, roster, readiness, credentials, shifts, officer safety, GPS, dispatch, welfare alerts, field reports, audit.

### E. Customer, agreement, and service accountability

Required document/workflow families:

- customer/site onboarding pack;
- service agreement brief;
- assignment instructions;
- patrol and attendance reports;
- customer review report;
- service exception and escalation notice;
- contract transition / Part 6A handover pack.

Every customer-facing output must state:

- period and scope;
- service agreement and site context;
- delivered work and exceptions;
- evidence basis and unresolved items;
- recipient and delivery timestamp;
- approval and version receipt.

### F. Records, documents, evidence, and media

Canonical objects:

- `bob_attachments` for private intake;
- `documents` for canonical storage registry and scope;
- `document_versions` for extracted/authored versions;
- `document_upload_events` for provenance;
- `evidence_items` / unified evidence media for operational evidence;
- `reference_catalog_entries` for approved retrieval;
- `audit_log` for action provenance.

Required document states:

`quarantined -> extracting -> needs_review -> draft -> approved -> promoted -> superseded | rejected | held | sealed | expired | revoked`.

Required output families:

- agreement and contract drafts;
- site safety plans and SOPs;
- risk and incident reports;
- training/deployment/supervision records;
- letters and controlled correspondence;
- reports and report packs;
- invoices and finance reconciliation drafts;
- HR/legal documents with restricted access;
- evidence packages and CCTV reports.

Media controls:

- organization-scoped brand assets;
- source hash, MIME/type, uploader, time, storage scope, and usage permission;
- image dimensions and quality checks;
- caption/alt text and source provenance;
- signed URLs with expiry;
- download and delivery audit;
- sealed evidence cannot be edited or deleted before retention expiry.

### G. Privacy, confidentiality, and access

Required controls:

- least-privilege role and organization access;
- explicit restricted spaces for HR, legal, medical, disciplinary, financial, and security-sensitive records;
- purpose-limited Bob retrieval;
- no raw storage paths or service-role credentials in browser or model context;
- access, download, export, promotion, and sharing audit;
- retention and legal-hold enforcement;
- incident/breach response workflow;
- subject/correction/export handling where applicable;
- redaction before external model or research use.

Bob's reference search must return approved retrieval handles and bounded metadata, not arbitrary bucket contents.

### H. Technology and AI assurance

Required controls:

- model identity, prompt/version, input scope, output, confidence, and run status;
- source references for generated claims;
- reproducible prompt/template version;
- refusal or escalation when evidence is missing or authority is unclear;
- separation of read, reason, propose, approve, and execute;
- idempotent commands and expected-state concurrency checks;
- evaluation suite for false positives, false negatives, privacy leakage, prompt injection, and stale context;
- tool catalogue derived from Atlas terrain and governed by Conductor effect permissions.

## Bob document workspace design

Bob's authoring surface should provide:

- role, organization, branch, agreement, site, zone, and purpose context;
- template selection by document family and workflow owner;
- approved reference rail with source handles and sensitivity state;
- structured fields alongside freeform rich text;
- photos, logos, diagrams, and evidence insertion with provenance;
- source citations at field/paragraph level where possible;
- missing-field and `[TO CONFIRM]` queues;
- draft, review, approval, promotion, delivery, and supersession states;
- version comparison and immutable receipts;
- output preview for PDF/DOCX/print only after review policy allows it;
- organization brand kit selection, never hardcoded logos or colors;
- explicit warning when a document is not legal, employment, safety, or compliance advice.

## Implementation roadmap

### Phase 0: evidence and policy foundation

- Register this control baseline in the product/design evidence set.
- Record source URL, publisher, retrieval date, document version, and applicability notes.
- Create a control-to-capability matrix with expected, present, missing, and contradictory states.
- Use Atlas and schema before every shared table, RPC, document, evidence, or auth change.

### Phase 1: shared safety and review spine

- Add risk/hazard, site-safety-plan, incident corrective-action, consultation, and management-review records or reuse verified existing equivalents.
- Add review states, owners, due dates, expected-state checks, audit events, retention, and legal hold.
- Add negative tests for cross-tenant access, unauthorized approval, sealed evidence edits, and stale decisions.

### Phase 2: document and brand system

- Add organization-scoped brand assets with approval, version, usage scope, and signed preview.
- Add versioned templates and document family metadata.
- Add structured source maps, citations, extraction runs, and generated-output receipts.
- Add PDF/DOCX generation only through governed server-side commands.

### Phase 3: workforce and service accountability

- Add training, competency, induction, deployment, supervision, working-alone, customer review, and contract-transition document flows.
- Link each output to staff, place, agreement, evidence, owner, and review/expiry state.

### Phase 4: assurance and proof

- Run seeded-tenant workflows using the approved sample corpus.
- Exercise desktop/mobile/browser and negative security tests.
- Refresh Atlas only after real callers and persistence are verified.
- Produce an evidence packet for every control domain; label unverified items as gaps.

## Release gates

No enterprise release of the safety/document/Bob surfaces until all of the following are true:

- no direct browser writes to consequential domain tables;
- all commands are authenticated, tenant-scoped, idempotent where retries are possible, and audited;
- every output has source, version, owner, review state, retention state, and receipt;
- restricted data cannot be found through unauthorized search or model retrieval;
- approval and rejection paths are tested with stale/concurrent states;
- sealed evidence and legal holds are enforced;
- desktop and mobile visual/keyboard workflows pass;
- accessibility, security, privacy, and dependency reviews pass;
- Atlas distinguishes present/wired from exercised;
- unresolved compliance gaps are visible to the customer and not hidden behind a generic status badge.
