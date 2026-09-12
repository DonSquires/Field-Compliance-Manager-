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
