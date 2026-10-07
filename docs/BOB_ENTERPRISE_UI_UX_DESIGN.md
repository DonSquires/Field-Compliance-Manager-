# Bob and FCM Enterprise UI/UX Design

Status: design baseline for implementation
Date: 2026-09-11

## Design intent

### Desktop workspace navigation (owner-requested, 2026-10-08)

The admin desktop shell uses one workspace selector and a section-specific
tool row rather than an always-expanded list of every page. The operating
organisation selector and existing role/module gates remain unchanged.
Role-permitted workspaces with no available tools remain visible as disabled
"Not enabled" entries. Their visibility does not confer subscription or route
access; role-prohibited workspaces are still omitted.

| Workspace | Owning workflow |
| --- | --- |
| Guarding & Patrol | Dispatch, patrol, live map, field reports, video evidence, places and workshop |
| HR & Rostering | Schedules, people/HR, work units, coverage and user access |
| CRM & Clients | Client portfolios, agreements, setup, onboarding and delivery handoff |
| Finance | Finance home, money, connections, costing, pricing and rate rules |
| Reports & Accountability | Historical agreement activity and governed client report packs |
| Investigations & Evidence | Investigation workspace and canonical file system |
| Organisation & Settings | Organisation configuration, access rules and subscriptions |

The overview stays a live-work queue. A clear queue offers a Reports next action;
it does not imply that historical activity is empty. Direct URLs and field-area
query parameters still work. Portfolio workflow identifiers are retained when
navigating between admin pages. Navigation does not create records, publish
reports, alter grants, or imply that a module is built or enabled.

Reference evidence retrieved 2026-10-08:

- [TrackTik security operations](https://www.trackforce.com/products/tracktik/security-operations/): connected dispatch, patrol, incident reporting and operational review.
- [Deputy scheduling](https://www.deputy.com/features/employee-scheduling): schedules, coverage, availability, time/attendance and workforce review.
- [Xero NZ](https://www.xero.com/nz/): connected invoicing, payroll and financial reporting.

These public product descriptions inform task grouping, not copied layouts or
proof of FCM capabilities. The local evidence gate is the existing fixture-backed
admin navigation and dispatch browser suite on desktop/mobile, plus shell
permission/routing guards and the production web build. PDF display, report media
attachment and case-intake completeness require separate record-workflow checks;
this navigation release does not claim those gaps are closed.

Bob is not a chat widget. Bob is the operating surface that helps authorized people understand work, gather evidence, draft artifacts, request review, and move through the FCM platform without bypassing the organization's source-of-truth systems.

The UI must feel like a calm enterprise operations console: queue-first, evidence-visible, role-aware, and honest about uncertainty. The interface must not imply that an AI answer is an approved safety, legal, employment, financial, identity, or enforcement decision.

This design follows:

- [FCM Enterprise Security and Good-Practice Design](ENTERPRISE_SECURITY_AND_GOOD_PRACTICE_DESIGN.md)
- [FCM Platform Architecture Brief](FCM_PLATFORM_ARCHITECTURE_BRIEF.md)
- [File System and Sample Data Build Plan](FILE_SYSTEM_AND_SAMPLE_DATA_BUILD_PLAN.md)
- [Bob Enterprise SaaS UX Training](BOB_ENTERPRISE_SAAS_UX_TRAINING.md)
- [NZSA Security Services Good Practice Guidelines](https://security.org.nz/wp-content/uploads/2023/04/NZSA-NZ-Security-Services-Good-Practice-Guidelines_April-2023.pdf)
- [W3C Web Content Accessibility Guidelines](https://www.w3.org/WAI/standards-guidelines/wcag/)

The early Freedom Camping prototype was inspected as a workflow reference. Its clear separation between field staff and admin entry points is useful. Its older, module-specific data model is not an architecture source and must not be copied into FCM.

## Product users and decisions

### Grand master, master, and administrator

Job: understand organizational work, risk, readiness, exceptions, and review queues.

Decisions:

- approve or reject a Bob proposal;
- assign a reviewer or owner;
- review a safety plan, incident, contract, report, or generated output;
- inspect source evidence and audit history;
- move a document or action to its next governed state.

Primary surface: Bob Command Center with queue, context, evidence, actions, audit, and linked platform destination.

### Operations supervisor or field coordinator

Job: keep work, people, sites, hazards, dispatch, and client commitments under control.

Decisions:

- deploy or hold work;
- acknowledge a risk or missing prerequisite;
- assign corrective action;
- review patrol, attendance, incident, welfare, and site outputs.

Primary surface: operations queue with Bob as a reasoning and document-preparation layer.

### Officer or field worker

Job: understand the current shift, task, site, hazards, escalation path, and evidence obligations.

Decisions:

- start or acknowledge work;
- report a hazard, incident, welfare concern, or observation;
- confirm what was seen and what remains unknown;
- read an approved site brief or safety instruction.

Primary surface: shift-first officer portal. Bob must not obscure SOS, welfare, GPS, dispatch, or evidence capture controls.

### Client or customer reviewer

Job: understand delivered service, exceptions, evidence, actions, and approvals within the client's scope.

Decisions:

- review a report pack;
- acknowledge an exception;
- request clarification;
- download an approved output.

Primary surface: client-scoped reports and document outputs. Internal Bob controls, HR/legal records, and draft proposals remain hidden.

## Information architecture

### Global shell

Persistent context must show:

- current organization and operating branch;
- current role and access scope;
- current agreement, site, zone, shift, or case when applicable;
- connectivity and safety state for field roles;
- Bob entry point and notification state.

Bob Command Center is the primary agent route:

- `/admin/bob` for management and platform roles;
- `/officer/bob` for authorized field roles;
- `/admin/document-studio` for focused authoring;
- `/admin/files` for the canonical file system;
- existing domain routes remain the source of truth for operational records.

### Bob Command Center

Three normal-flow desktop panes:

1. **Work queue**
   - active task and conversation sessions;
   - pending review and approval items;
   - paused or blocked tasks;
   - recent evidence and generated outputs;
   - filters for active, needs review, blocked, completed, and archived.
2. **Work surface**
   - Bob conversation and structured task activity;
   - current context ribbon;
   - work-state timeline;
   - next safe action;
   - source and evidence references;
   - explicit proposal boundary.
3. **Inspector**
   - Context: organization, branch, agreement, place, staff, task, and scope;
   - Files: source documents, versions, extraction states, and media;
   - Actions: governed proposals and actual persisted statuses;
   - Audit: conductor events, actor, tool, outcome, timestamp, and receipt.

On mobile, the work surface remains primary. Queue and inspector become full-width drawers with clear close controls and preserved focus.

### Document Studio

Document Studio is not a blank page. It is a governed authoring workspace:

1. **Document setup rail**
   - title, family, organization, branch, agreement/site/zone context;
   - owner, reviewer, due date, review date, sensitivity, retention class;
   - template and output format;
   - visible draft/approval/promotion state.
2. **Document canvas**
   - structured rich text with headings, lists, tables, callouts, page breaks, and accessible keyboard controls;
   - source-linked citations and evidence markers;
   - inline `[TO CONFIRM]`, missing-field, and provisional markers;
   - autosave indicator that never claims persistence until the governed command returns a receipt.
3. **Evidence and reference rail**
   - approved references searched through the mediated Bob retrieval path;
   - selected sources with trust, jurisdiction, publisher, sensitivity, and retrieval handle;
   - attached photos, logos, diagrams, and evidence items;
   - source preview and citation insertion;
   - no raw bucket browsing.
4. **Review/receipt strip**
   - draft status and owner;
   - source coverage and unresolved fields;
   - approval requirements;
   - retention and sharing warning;
   - save, submit for review, compare versions, and preview output actions.

## Document families and templates

Templates are data-driven and organization-aware. Template selection never hardcodes a council or client name.

### Safety and operations

- site safety plan;
- hazard register and control review;
- security risk assessment;
- emergency response plan;
- emergency drill record;
- working-alone and remote-work plan;
- pre-start and deployment checklist;
- site handover and assignment instruction;
- supervision and welfare review;
- patrol and attendance report.

### Incident and improvement

- incident report;
- near-miss report;
- investigation and root-cause review;
- corrective/preventive action plan;
- effectiveness review;
- worker consultation record;
- management review and continual-improvement report.

### Customer and commercial

- service agreement brief;
- customer onboarding pack;
- customer service review;
- service exception and escalation notice;
- contract-transition / Part 6A handover pack;
- RFQ/proposal draft;
- monthly client report pack;
- invoice or finance reconciliation draft.

### People and controlled correspondence

- induction and competency record;
- training/refresher record;
- credential/certificate review;
- employment or HR correspondence draft;
- disciplinary or legal correspondence draft;
- restricted case summary.

### Evidence and reporting

- CCTV evidence report;
- investigation evidence package;
- field report;
- audit evidence pack;
- source comparison and version-change report.

Every template declares:

- owning domain and authorized roles;
- required context fields;
- required evidence types;
- sensitivity and retention defaults;
- reviewer and approval policy;
- allowed promotion target;
- output formats;
- source citation requirements;
- whether photos, logos, or signatures are permitted.

## Brand and media design

### Organization brand kit

A future `organization_brand_assets` capability should support:

- organization and optional branch scope;
- asset type: logo, mark, wordmark, letterhead, footer, color palette, typography guidance, signature block;
- storage object and SHA-256 hash;
- MIME type, dimensions, accessibility text, and safe-area metadata;
- active/version/revoked state;
- approved by, approved at, and usage scope;
- light/dark/print variants;
- retention and replacement history.

Until that exists, the editor must not silently use a hardcoded organization logo. It may show an explicit `No approved brand asset` state and allow a governed asset request.

### Photos and evidence

Inserted media must show:

- evidence/document source;
- capture or upload time;
- organization/site/zone scope;
- hash or evidence ID;
- review state;
- caption and alternative text;
- retention/seal state.

A photo in a document is a reference to an evidence/media record, not an untracked copied blob.

## State and interaction contracts

Every page and command implements these states:

- loading: what is being retrieved;
- empty: why nothing exists and the next safe action;
- blocked: which role, tenant, evidence, or approval is missing;
- error: human-readable cause, request/correlation ID where safe, recovery;
- draft: editable, not authoritative;
- needs review: named owner and reason;
- approved: who approved, when, and what was approved;
- rejected: rationale and next action;
- superseded: link to replacement;
- held/sealed: why editing/download/promotion is restricted;
- saved: governed receipt, IDs, version, audit event, and downstream next step.

No button should imply that a document is final when it is only drafted. No success state should appear when the command or audit receipt failed.

## Accessibility and responsive behavior

The implementation target is WCAG 2.2 AA-aligned behavior, subject to product testing and expert review.

- every input has a label and every icon-only control has an accessible name;
- toolbar buttons expose pressed state and keyboard operation;
- focus remains visible after drawers, dialogs, template insertion, and save receipts;
- status and error messages use appropriate live regions;
- color never carries status alone;
- long filenames, titles, evidence captions, and errors wrap without horizontal overflow;
- document canvas remains readable at 320px content width;
- the primary action and current context remain visible on mobile;
- print and exported documents include document title, page numbering, organization identity, source/approval metadata, and accessible alternative text for meaningful images.

## Prototype/reference lessons

The Freedom Camping prototype's useful reference patterns are:

- separate field-staff and admin entry points;
- immediate operational destinations rather than a marketing landing page;
- clear labels for breaches, zones, users, and analytics;
- a visible distinction between field work and administrative oversight.

The prototype must not be copied for:

- organization and place ownership;
- compliance truth;
- direct module table writes;
- evidence custody;
- approval or audit behavior;
- tenant and role policy.

## Acceptance and human-test plan

A document workflow is not complete until a human test demonstrates:

1. correct organization, branch, role, and document-family context;
2. source search with permitted references only;
3. template insertion and accessible rich-text editing;
4. photo/logo selection with provenance and usage state;
5. missing-field and `[TO CONFIRM]` handling;
6. governed draft save with audit receipt;
7. reload and version persistence;
8. submit-for-review and rejection behavior;
9. restricted document denial for an unauthorized role;
10. desktop and mobile screenshots with no clipping or horizontal overflow;
11. browser console and failed-request review;
12. a final report stating expected, present, missing, contradictory, and next-step evidence.

## Design evidence and research notes

The Freedom Camping preview was visually inspected as a workflow reference and had no login, console errors, failed requests, or horizontal overflow. It did not expose an enterprise document editor or a reusable branding/reference model.

The NZSA guideline research identified the following direct UI/workflow implications: site onboarding risk review, site safety plans, incident and emergency reporting, worker engagement, deployment and supervision, working-alone controls, customer communication, accurate record keeping, technology governance, accountability, auditing, and continual improvement.

The current FCM live reference catalog and report-pack tables were checked read-only on 2026-09-11. No approved reference catalog entries or monthly report-pack rows were present. Twenty-five sampled organizations had no `logo_url`, and no notice templates were present. The UI must therefore represent missing reference and branding states truthfully rather than fabricate examples.
