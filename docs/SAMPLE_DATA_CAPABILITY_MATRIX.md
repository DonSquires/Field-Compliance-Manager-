# Sample Data Capability Matrix

This matrix maps the files in `Build-Plan/sample data` to the product capability the application and Bob should provide. It is an assessment of capability ownership, not permission to upload or process the files. The source set contains potentially sensitive employment, legal, commercial, customer, and operational information.

## Status meanings

- **Supported**: a governed application or Bob path exists for the primary action.
- **Partial**: intake or an adjacent workflow exists, but classification, extraction, approval, or output is incomplete.
- **Gap**: no verified end-to-end path was found.
- **Exclude**: temporary, empty, or diagnostic artifact that should not enter business records.

## File matrix

| File | Capability the app/Bob should provide | Canonical destination/output | Status |
|---|---|---|---|
| `107 Gorge Road - Service Agreement.pdf` | Extract customer, site, services, term, rates, and obligations; propose an agreement workspace for human confirmation | CRM organization, client site, service agreement, modules, rate rules | Partial |
| `20.08.28 - First Guard Security Services - Contractor Evaluation.pdf` | Classify supplier evaluation, extract scored findings and actions, assign owners and due dates | Vendor/contractor review record and audit tasks | Gap |
| `20.08.28 - First Guard Security Services - Review Letter.pdf` | Register controlled correspondence and link it to the contractor review | Document version, review case, audit trail | Partial |
| `20.08.28 - First Guard Security Services - Terms & Condtions.pdf` | Extract contractual terms and make them searchable with source citations | Tenant reference document / agreement evidence | Partial |
| `3. Ecan Monthly Report June 24.docx` | Parse monthly operational report into incidents, hazards, patrol activity, attendance, and client-report evidence | Report pack inputs, field incidents, follow-up tasks | Partial |
| `Agreement.pdf` | Identify agreement type, parties, term, services, and obligations | CRM agreement workspace | Partial |
| `Copy of C4 COA Registration Form registration 11.1.23.xlsx` | Read certification/application fields, validate required values, and attach the source | Staff credential/application record with review queue | Partial |
| `ESH551_6.JPG` | Register image evidence with hash, provenance, and optional human classification | Evidence item / incident attachment | Supported |
| `Expense Reimbursement 22.08.22.pdf` | Extract claimant, expense lines, dates, tax, approval state, and payment evidence | Finance reimbursement workflow | Gap |
| `F-Emergency-Appointment.pdf` | Classify emergency appointment or employment document, extract person/date/authority | HR case or staff record with restricted access | Partial |
| `FIRST Security Dunedin_202852_MBIECT-9934.pdf` | Extract compliance certificate/license authority, jurisdiction, holder, expiry, and verification state | Staff/company credential record | Partial |
| `FIRST Security Guard Services Limited - HR Pay Costing EDIT DUN.pdf` | Extract pay-costing rows, rates, assumptions, and effective dates; require approval | Rate rules/pay-costing review | Partial |
| `FIRST Security Guard Services Limited - HR Pay Costing EDIT INV.pdf` | Extract invoice costing and reconcile against agreement/rate rules | Invoice or commercial reconciliation workspace | Partial |
| `FIRST Security Guard Services Limited - HR Pay Costing.pdf` | Extract baseline labour-cost model and compare revisions | Governed rate-rule version and approval history | Partial |
| `FIRST Security Queenstown_203341_MBIECT-9934.pdf` | Extract and verify regional compliance certificate | Credential/compliance record | Partial |
| `FIRST Security_ Invercargilll203535_MBIECT-9934.pdf` | Extract and verify regional compliance certificate | Credential/compliance record | Partial |
| `FLM Attendance Template MkIII.docx` | Convert attendance form fields into a structured dispatch/job completion template | Dispatch attendance record and evidence package | Partial |
| `FS Logo.jpg` | Store approved brand asset with tenant/brand metadata | Organization branding asset | Gap |
| `First Security Assignment Instruction Template 22 Dec 2020.docx` | Extract site instructions, patrol tasks, contacts, alarms, equipment, and reporting requirements | Site brief, work unit, patrol route, officer handover | Partial |
| `First Security Service Agreement- Department of Conservation - Te Papa Atawhai.docx` | Extract and compare agreement terms, locations, charges, dates, and parties | CRM agreement draft plus source-linked clauses | Partial |
| `First Security Service Agreement- Department of Conservation - Te Papa Atawhai.pdf` | Preserve signed/rendered agreement and compare to editable source | Immutable agreement evidence and version comparison | Partial |
| `First Security South Port Safety Agreement.pdf` | Extract safety-specific services, hazards, obligations, and emergency requirements | Agreement modules, site safety brief, risk controls | Partial |
| `First Security Template Service Agreement (_9766655_1).docx` | Use as a governed agreement template with merge fields and version control | Agreement template catalog and generated draft | Partial |
| `Gemini Goals and V Document.pdf` | Classify strategy/goals document and extract objectives, measures, owners, and review dates | Organization goals/operating plan | Gap |
| `HPLJM278-M281_Fax_Port` | Ignore empty placeholder; do not create a business record | None | Exclude |
| `Invite to Discip Meeting Post Investigation Rajan V2.docx` | Extract disciplinary case, allegation summary, meeting date, employee, and required notice controls | Restricted HR investigation and generated correspondence | Partial |
| `Invite to Discip Meeting Post Investigation Rajan V2.pdf` | Preserve issued disciplinary correspondence and link to the HR case | Immutable HR case evidence | Partial |
| `KS-610289-1-11-1 Employer Affidavit V2.docx` | Classify affidavit, extract declarant, proceeding purpose, employment facts, and review status | Restricted legal/HR matter and evidence register | Gap |
| `Kirsten COA tem app.pdf` | Extract temporary certificate/application fields and expiry/conditions | Credential application and verification queue | Partial |
| `L-Request-Temp-CoA2-Linda Craw.pdf` | Extract temporary certificate request, applicant, reason, and status | Credential application workflow | Partial |
| `LINZ Weekly Incidents Report 251228.docx` | Parse weekly contract report into incidents, vehicle observations, patrol coverage, education activity, and client reporting | Investigation/incident records, observations, report pack | Partial |
| `Proforma Template.docx` | Extract commercial onboarding fields, contact details, service selections, rates, and term | CRM account/proposal/agreement draft | Partial |
| `Supply Agreement First Security 2020.pdf` | Extract supplier agreement parties, obligations, pricing, term, and renewal conditions | Supplier/contract workspace | Gap |
| `Temporary Service Agreement June 2020.xlsx` | Read agreement schedule/rates/locations and validate spreadsheet cells | Agreement import preview and human-approved CRM records | Partial |
| `The Warehouse Security Officer Handout Dec 2020.pdf` | Extract site induction, officer duties, safety controls, and escalation instructions | Site brief, training/induction content, officer handover | Partial |
| `Wilson FSGS MV CofC 20-21.pdf` | Extract motor-vehicle certificate details and expiry | Asset/vehicle compliance record | Partial |
| `Wilson FSGS PI CofC 20-21.pdf` | Extract public-liability insurance certificate and coverage dates | Organization insurance/compliance record | Gap |
| `Wilson FSGS PL CofC 20-21.pdf` | Extract professional-liability insurance certificate and coverage dates | Organization insurance/compliance record | Gap |
| `fcm-dhfs-diagnostic-bytes.bin` | Retain only as a quarantined engineering diagnostic if explicitly needed; never classify as business evidence automatically | Quarantine/diagnostic artifact | Exclude |
| `~$rst Security Template Service Agreement (_9766655_1).docx` | Ignore Office lock file | None | Exclude |

## Capability summary

### Already present

- Bob document upload, extraction, registration, search, versioning, promotion, and review surfaces.
- CRM organizations, sites, service agreements, modules, proposals, invoices, and monthly report packs.
- Governed evidence registration, court-ready sealing, CCTV import, motion inference, and review.
- Dispatch, roster, field reports, credentials, and officer handover primitives.
- Bob proposal paths for client onboarding, locations, sites, patrol routes, rates, staff onboarding, and roster fill.

### Material gaps exposed by this corpus

1. A document classification and extraction schema for agreement, certificate, invoice, expense, HR/legal, incident report, site instruction, and insurance documents.
2. Human approval queues that turn extracted candidates into CRM, HR, finance, credential, and evidence records without treating OCR/LLM output as authoritative.
3. Agreement-to-roster/site-brief extraction from assignment instructions and attendance templates.
4. Pay-costing, expense reimbursement, supplier agreement, and insurance certificate workflows.
5. Restricted HR/legal case ingestion with access, retention, legal hold, and correspondence generation.
6. Source-linked generated outputs: agreement drafts, review letters, disciplinary notices, site briefs, invoices, report packs, and audit-ready export packages.
7. Spreadsheet import previews with cell-level validation, duplicate detection, and rollback-safe promotion.
8. Provenance and deduplication across source file hash, document version, tenant, and business record.

## Recommended implementation order

1. Build a quarantined document intake classifier and source register for this corpus; exclude the lock, empty, and binary artifacts.
2. Implement extraction previews for agreements, certificates, invoices/pay-costing, incident reports, and HR correspondence.
3. Add human approval commands that promote approved fields through existing governed RPCs.
4. Add restricted HR/legal and finance workflows before processing those sensitive files.
5. Add generated document templates and source-linked outputs.
6. Run Atlas refresh only after each promoted path has real callers and exercised evidence.