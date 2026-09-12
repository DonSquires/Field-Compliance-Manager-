# Sample Data Browser Seed Plan

Status: active follow-up

## User contract

Sample data must enter FCM through the same visible browser workflows a human uses: file chooser, fields, buttons, review screens, approval dialogs, receipts, and the resulting data views. Direct service-role inserts and hidden bulk seed scripts are not the acceptance path. Playwright may drive the browser as the approved human test operator, but it must not bypass the visible controls.

Observations are the final batch. They must not be created until the organisation, clients, agreements, places, sites, zones, staff, credentials, rosters, dispatch, finance, documents, and evidence paths have been traced and their failures recorded.

## Current corpus evidence

Manifest run: 2026-09-12T07:28:54.382Z

- 14,185 files
- 28,002,352,417 bytes
- 1,212 documents
- 565 structured-data files
- 10,046 media files
- 2,196 quarantined files
- 6 archives requiring review
- 158 unclassified files
- 2 excluded placeholders

The sample corpus is substantially larger than the original 40-file acceptance set. It includes sensitive HR/legal, finance, personal, operational, and media material. Quarantine and exclusion decisions must remain visible and must not become business records.

## Browser baseline

Production human walkthrough: `HUMAN_TEST_LIVE=true` against `https://www.fcmanager.co.nz`, desktop Chromium, 2026-09-12.

- 2 browser tests passed
- 0 browser errors
- 107 UX findings, primarily text below 12px and unnamed interactive controls
- Finance navigation and Core ANZ/IRD connection screens were reachable

First live browser intake batch: `107 Gorge Road - Service Agreement.pdf` uploaded through the File System chooser on 2026-09-12 after deployment `95ca384`.

- Visible receipt: registered for review
- Browser console errors: 0
- Failed Supabase responses: 0
- Promotion: not performed; the source remains in the review boundary

Finance browser batch: three source files uploaded through the same visible intake on 2026-09-12.

- `FIRST Security Guard Services Limited - HR Pay Costing.pdf`
- `Expense Reimbursement 22.08.22.pdf`
- `April 2026 Noise billing.xlsx`
- Receipts: 3 registrations
- Browser console errors: 0
- Failed Supabase responses: 0
- Promotion: not performed; finance classification and reconciliation review remain pending

Finance spreadsheet classification approval: `April 2026 Noise billing.xlsx` was reviewed through the live Approvals dialog on 2026-09-12.

- Privacy class: tenant sensitive
- Financial data: confirmed
- Review reason: finance source requires tenant-scoped finance review before promotion
- Visible receipt: classification review recorded
- Browser/alert errors: 0
- Promotion: not performed

OCR/parser finding: local Poppler and Tesseract verification on 2026-09-12 found embedded text in both finance PDFs that the live registration currently marked `OCR required`:

- `FIRST Security Guard Services Limited - HR Pay Costing.pdf`: 2 pages, embedded pay-costing text present.
- `Expense Reimbursement 22.08.22.pdf`: 1 page, embedded expense-form text present.

Diagnosis: the deployed `bob-extract-document` PDF parser was failing to recognise these text streams. The parser was fixed with Deno-compatible `unpdf`, the deduplicated version refresh was corrected, and both files were re-registered through the browser. They now show extracted source previews and restricted finance review states. They remain unapproved and unpromoted until the finance reviewer completes the visible approval workflow.

Remediation evidence:

- `FIRST Security Guard Services Limited - HR Pay Costing.pdf`: extracted preview, 70% Bob confidence, restricted review state.
- `Expense Reimbursement 22.08.22.pdf`: extracted preview, 70% Bob confidence, restricted review state.
- Browser errors during both re-registrations: 0.

Finance PDF classification approvals: both corrected PDFs were reviewed through the live Approvals dialogs on 2026-09-12.

- Privacy class: restricted
- PII: confirmed
- Financial data: confirmed
- Visible receipts: two classification reviews recorded
- Browser/alert errors: 0
- Finance proposal promotion: not performed

Finance E2E internal writes: completed through the live browser workflow on 2026-09-12, excluding all bank and IRD linking.

- Approved the Expense Reimbursement finance proposal and created draft invoice `E2E-EXP-20260912-01` with subtotal `$181.12`, GST `$17.64`, total `$198.76`.
- Approved the HR Pay Costing finance proposal and created draft invoice `E2E-PAY-20260912-01` with subtotal `$4,000`, GST `$600`, total `$4,600`.
- Ran the visible costing/depreciation calculation with labour, asset, equipment, overhead, and margin inputs; annual depreciation receipt returned `$2,400`.
- Bank and IRD linking controls were not opened or submitted.
- Browser errors and alerts during successful invoice writes: 0.

Follow-up findings from the same E2E run:

- Creating a billing rate rule was blocked by the server with `Active authorized operating branch finance administrator required`; no rule was written.
- The costing receipt returned `$0.00` true cost/client charge despite populated labour and direct-cost fields while returning depreciation. Root cause confirmed: depreciation was allocated through `vehicle_productive_hours = 0`, producing PostgreSQL null propagation. The RPC now fails clearly with `Vehicle productive hours are required to allocate asset depreciation`.
- Live remediation verified: invalid zero-allocation input displayed the explicit error; valid `vehicle_productive_hours = 2080` returned `$580.26` true cost, `$773.68` client charge, 25% margin, and `$2,400` annual depreciation.
- Rate-rule E2E retry remained blocked with `Active authorized operating branch finance administrator required`. The governing RPC requires both `user_can_operate_organization()` and `is_admin_for_org()` for an active organization of type `branch`; the visible operating context alone is insufficient. No rate rule was written.
- The Finance money summary loaded without errors but did not show the new draft invoice numbers. Code tracing confirms this surface intentionally queries periods, P&L snapshots, tax periods, variances, receipts, and external transactions; it is not an invoice ledger. Draft-invoice persistence is evidenced by the approval receipts, while invoice-list visibility belongs to the CRM/finance invoice surface and remains a separate verification task.

Finance proposal preparation: both approved PDFs were sent through the visible `Prepare finance proposal` action on 2026-09-12.

- Visible receipts: two files ready for human Finance Reconciliation review
- Browser/alert errors: 0
- Canonical finance writes: not performed
- Next reviewer action: inspect proposal fields and approve/reject through the finance reconciliation workflow

## Confirmed browser-seeding gap

The File System page previously provided CSV/XLSX preview, but no general human-visible upload/register control for the corpus. A one-file role-gated intake control is now implemented locally and reuses private `bob-uploads`, `bob_attachments`, and `bob-document-register`. It must be deployed before the production browser seed can start. Bob Document Studio still exposes brand-asset upload separately.

## Seed order

1. Organisation and client portfolio foundations.
2. Agreements, sites, locations, zones, services, rates, and operational instructions.
3. Staff, credentials, HR records, rosters, and dispatch setup.
4. Finance: IRD setup, costing assumptions, finance documents, statement/reconciliation review.
5. Evidence and media registration through their dedicated review surfaces.
6. Reports and generated outputs.
7. Observations last, after source entities and policy boundaries are verified.

Each batch must capture before/during/after evidence, source filename/hash, browser route, visible action, approval receipt, created record IDs, skipped/quarantined files, and any failed network/API request.

## Next implementation

Add a role-gated, tenant-scoped generic intake control to the File System UI. It should upload to private Bob storage, register provenance, classify/quarantine, expose extraction/review state, and require a visible human approval action before promotion. The control must support one file at a time initially so Playwright and human reviewers can trace each file without hiding partial failures.
