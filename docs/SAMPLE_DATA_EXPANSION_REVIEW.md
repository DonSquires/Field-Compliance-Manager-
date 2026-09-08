# Expanded Sample Data Review and App Polish Backlog

## Corpus delta

The sample folder is actively growing and now contains nested personal/application folders. The latest hardened manifest found **5,648 files / 8.93 GB** after skipping embedded repository/build internals. It is no longer primarily a document-intake fixture. It is a broad operational dataset containing fleet history, vehicle compliance, patrol history, timesheets, training, billing, organisations, zones, CCTV/media, email, legacy exports, personal folders, source code, and application/install artifacts.

Because the folder is changing while review is in progress, the importer must use a versioned manifest snapshot rather than assuming the folder is static. Record snapshot time, file count, total bytes, hashes, skipped directories, and quarantine decisions before each batch. Embedded `.git` directories and build dependency directories must never be traversed.

Generate a local manifest with:

```bash
npm run sample:manifest > sample-data-manifest.json
```

The command streams each file through SHA-256, records size and modification time, skips repository/build internals, and assigns an ingestion class plus quarantine reason. It does not upload, execute, extract, or modify the source files.

This review is read-only. No sample file is uploaded, imported, executed, or modified.

## Immediate quarantine rules

The following must be excluded from generic Bob document intake and placed in a non-executable quarantine manifest:

- `*.exe` such as `OfficeSetup.exe`
- `*.apk` such as `FreedomCampManager.apk`
- `*.lnk`, `*.url`, and shortcut/link files
- `*.crdownload`, `*.download`, and partial downloads
- `*.bin`, `*.accdb`, `*.mdb`, `*.db`, diagnostic binaries, and unknown database files
- `*.ini`, `*.log`, `*.prn`, and system/application configuration artifacts unless a named parser owns them
- Office lock files beginning with `~$`
- Archives containing any of the above until inspected in a sandbox

The intake UI should show these as **quarantined / unsupported**, explain why, and never offer “Register in Files” or extraction for them.

## New capability families

### 1. Fleet and vehicle intelligence

New examples include:

- `VehicleRecords.csv`
- `canonical_vehicles_rows.csv`
- `canonical_vehicles_rows (1).csv`
- `vehicle_records_2026.json`
- `vehicle_records_2026_full_with_org.json`
- `vehicle_records_2026_full_with_org.xlsx`
- `VehicleYear-2026.csv`
- `vehicles_export_2026-01-26.csv`
- `Vehicle List - 17022026.xlsx`
- `Vehicle Log*.csv`
- `Site Report By Vehicle*.csv/.xlsx`
- vehicle search forms, vehicle certificates, GPS screenshots, and vehicle reports

**Polish required:**

- Add an import preview with detected schema, row count, duplicate count, invalid plate count, organisation resolution, and date range.
- Map legacy fields into canonical vehicle/observation tables without direct table writes.
- Provide column-level mapping for plate, make, model, year, colour, self-contained state, owner/status, GPS, and event time.
- Keep source rows and hashes for every import batch.
- Add a vehicle history workspace that clearly separates registry facts, field observations, breaches, GPS events, and human flags.
- Require human review before importing homelessness/identity/flag status.

### 2. Patrol, dispatch, and operational history

New examples include:

- `Nelson Patrol Historical data.csv`
- `Patrol Reports*.csv`
- permanent patrol run sheets
- patrol minimum requirements
- site reports by vehicle
- QR locations and QR code PDFs/images
- patrol report HTML exports

**Polish required:**

- Add a batch-import preview for patrol routes, stops, attendance, and patrol outcomes.
- Resolve imported site/location names against canonical Location, Site, Zone, and service-agreement records.
- Show unresolved references as a human review queue instead of silently creating duplicates.
- Add run-sheet generation from approved roster/work-unit definitions.
- Add QR asset registration linked to canonical checkpoints, not free-floating image files.

### 3. Timesheets, payroll, and billing

New examples include:

- `Timesheet Report*.csv`
- `Training Records.csv`
- `Jan/June/July 2026 Noise billing.xlsx`
- wage adjustment spreadsheets
- payslips and pay-costing documents
- expense and invoice material from the earlier corpus

**Polish required:**

- Add a source import batch with preview, employee matching, payroll-ID matching, period coverage, and duplicate detection.
- Reconcile timesheet rows to completed shifts/work records before proposing timesheet changes.
- Reconcile noise billing rows to assessment, agreement, rate rule, and invoice records.
- Add variance views: imported amount, canonical amount, difference, reason, and approval state.
- Never allow imported payroll or invoice data to overwrite canonical records directly.

### 4. Training, competency, and credentials

New examples include:

- parking warden training guides and sign-off matrices
- patrol training sign-off templates
- NZCiS L3/L4 criteria and competency files
- refresher records
- consent forms and licence applications
- training videos and presentations

**Polish required:**

- Add a training/competency document classifier distinct from credential certificates.
- Promote approved evidence to staff documents, credentials, skills, training records, and expiry queues.
- Show the source page/section supporting each competency field.
- Keep biometric, medical, consent, and employment documents in restricted HR spaces.
- Add renewal and retraining reminders tied to canonical expiry dates.

### 5. Organisation, geography, and configuration imports

New examples include:

- `Organizations.csv`
- `Zones.csv`
- Deputy locations/sites/patrol-zone exports
- QR location exports
- API specifications and backend sync documents

**Polish required:**

- Add organisation/branch/client matching with explicit merge candidates.
- Map zones to canonical Location/Site/Zone records and require geometry validation.
- Add an import dependency graph: organisations before sites, sites before zones, agreements before contracted work units.
- Add “preview only” mode that reports collisions and missing parent records.

### 6. Correspondence, incidents, and investigation material

New examples include:

- `.msg`, `.eml`, `.htm`, and email-style correspondence
- incident reports and unauthorised-vehicle notices
- expectation letters, consent forms, affidavits, and employment correspondence
- hospital and public-site reports

**Polish required:**

- Add email/message extraction with sender, recipients, subject, sent time, attachments, and thread identifiers.
- Map correspondence to an existing investigation, incident, client, staff profile, or service agreement only after review.
- Restrict HR/legal correspondence by explicit role and legal hold.
- Preserve original message/container and extracted text separately.
- Add “link to investigation” as a governed proposal, not a direct generic link.

### 7. CCTV and media

New examples include:

- MP4/AVI videos
- screenshots and JPEG/PNG/HEIC images
- CCTV reports, vehicle images, QR locations, and training media
- compressed OneDrive/Fleet archives

**Polish required:**

- Route video through the dedicated CCTV intake and inference workflow.
- Show source, playback derivative, motion, keyframes, ALPR candidates, and face review states separately.
- Add media duration/codec/size checks before extraction.
- Use signed URLs and short-lived playback access.
- Never treat an archive or executable as ordinary media.

## File-system UX changes needed

The current Files workspace is a good document registry, but the expanded corpus requires a richer intake model:

1. **Import batches**: one batch per upload/import operation with source, uploader, hash, row/file count, status, and rollback boundary.
2. **Type-specific parser selection**: document, spreadsheet, CSV, JSON, email, image, video, archive, or unsupported/quarantined.
3. **Schema preview**: detected columns, sample rows, date range, organisation matches, warnings, and duplicate counts.
4. **Human mapping**: source field to canonical field mapping with confidence and sample values.
5. **Dependency warnings**: missing organisation, client, site, zone, agreement, staff, vehicle, or payroll identity.
6. **Promotion destination**: credentials, staff document, work unit, investigation link, finance reconciliation, vehicle import, or evidence.
7. **Batch receipts**: created, skipped duplicate, unresolved, rejected, quarantined, and failed counts.
8. **Rollback/review**: imports remain provisional until approved; no hidden partial writes.

## Priority order for app polishing

### P0: quarantine and intake safety

- Extension/MIME/size policy.
- Executable/archive/download quarantine.
- SHA-256 file and batch manifest.
- No generic extraction for unsafe artifacts.

### P1: CSV/XLSX import preview

- Vehicle, organisations, zones, timesheets, training, billing, and patrol exports.
- Column mapping and duplicate detection.
- Tenant/branch matching and unresolved-reference queue.

### P1: vehicle workspace polish

- Registry/observation/breach/GPS separation.
- Import history and source provenance.
- Field review for self-contained, homelessness, flag, and compliance fields.

### P1: roster/pay/billing reconciliation

- Timesheet import against completed work.
- Noise billing and pay adjustment reconciliation.
- Draft-only finance output until approval.

### P2: training and credential workspace

- Training matrix, competency evidence, expiry, refresher, and credential proposals.

### P2: correspondence and investigation workspace

- MSG/EML extraction, thread linking, legal/HR access, investigation proposal links.

### P2: CCTV/media polish

- Multi-format media intake, archive inspection, playback derivatives, and review packages.

## Data-quality risks found

- Duplicate export families exist, including `canonical_vehicles_rows.csv` and its numbered copy, duplicate NZCiS files, duplicated training/policy documents, and repeated OneDrive archives.
- Several filenames are opaque UUIDs and require content/schema classification before routing.
- Some exports appear to contain organisation columns while others do not; organisation resolution cannot be assumed from filenames.
- Large historical files such as `VehicleYear-2026.csv`, `Fleet-data-all-vehicle-years.zip`, and Teams videos require streaming/resumable processing rather than browser memory loading.
- The current largest files include duplicate Teams videos, `Fleet-data-all-vehicle-years.zip`, multiple CCTV/video assets, and large historical vehicle CSVs; the importer must deduplicate by content hash before expensive extraction.
- The hardened manifest classified 2,196 files as quarantine, 1,583 as media, 1,163 as documents, 546 as structured data, 154 as unclassified, and 6 as archive-review candidates. Of the quarantined files, 2,117 are source/configuration/engineering artifacts, 79 are executable/partial/link/database/diagnostic artifacts, and 154 have no registered parser.
- Personal, payroll, consent, medical, disciplinary, and legal material is mixed with operational files and requires restricted spaces before extraction.

## Acceptance corpus plan

Do not upload the entire 1.7 GB folder to a live tenant. Create a sanitized fixture manifest with:

- representative files from every format/domain
- hashes and source filenames
- expected parser and destination
- expected duplicate/invalid/unresolved outcomes
- quarantined artifact cases
- cross-tenant access negative cases
- large-file streaming cases

The manifest should drive importer unit tests, browser walkthroughs, Atlas expectations, and eventual seeded integration tests.