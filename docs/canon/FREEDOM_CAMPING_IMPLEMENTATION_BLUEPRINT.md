> **Canonical copy.** Origin: GitLab `don-squires1/field-compliance-manager` `` @ `Main`, read 2026-09-14 via `scripts/gitlab-read.mjs`. This repository (`DonSquires/Field-Compliance-Manager-` `main`) is the authoritative home from now on; the GitLab text is lineage. Edit here and record the ruling — never fork the text. Links to files that do not exist in this repo refer to that lineage.

# Freedom Camping Implementation Blueprint

**Status:** Active build blueprint  
**Source context:** Old `FreedomCamp-Manager` docs/code, especially `INSTRUCTION_MANUAL.md`, Freedom Camping audit/update docs, ParkPow integration notes, scanner components, and enforcement functions.  
**Implementation target:** New clean `field-compliance-manager` architecture.

---

## 1. Build principle

Freedom Camping is a core product module, not a demo shortcut. It must support:

- Standalone Freedom Camping clients.
- Integrated operations clients using CRM, Staff, Roster, Dispatch, Welfare, and Reporting.
- Evidence-grade enforcement workflows.
- Admin/master/client reporting.

The old app is used as product memory and lessons learned. The new app must not blindly copy old implementation patterns.

---

## 2. Operating modes

### Standalone Freedom Camping mode

Used when a client only wants the Freedom Camping module.

Requires:

- Authenticated authorised operator.
- Client/site/zone configured.
- Mandatory photo evidence.
- ALPR-first scan.
- Manual plate fallback only when ALPR/Plate Recognizer cannot produce a usable plate.
- Backend processing through `process-officer-scan`.

Does not initially require:

- published roster.
- credential validation.
- staff scheduling.
- shift acceptance.

### Integrated operations mode

Adds:

- staff profiles.
- credential checks.
- rostered shifts.
- zone/site assignment.
- welfare/timesheet linkage.

---

## 3. Officer scanner requirements

The officer scanner must be a purpose-built scanner surface, not a plain upload form.

Required scanner modes:

1. **Standard Scan**
   - live camera or native camera fallback.
   - mandatory evidence photo.
   - ALPR first.
   - manual plate fallback only after ALPR failure/low confidence.

2. **Zoom Scan**
   - zoom control overlay based on old `ZoomScan` intent.
   - plus/minus controls.
   - visible current zoom level.
   - future live-camera implementation should apply device zoom constraints where supported.

3. **Detail Scan**
   - close-up evidence capture for plates, signage, stickers, permits, or scene details.
   - linked to observation/session as supporting evidence.

4. **Bulk Scan** later
   - continuous/high-volume mode.
   - queue results for quick officer confirmation.

---

## 4. Evidence requirements

Every valid scan requires a photo.

Evidence package must include:

- original image.
- watermarked image.
- date/time.
- GPS coordinates.
- site/zone.
- officer.
- plate if known.
- observation id.
- EXIF capture timestamp when available.
- EXIF GPS latitude/longitude when available.
- capture device make/model when available.
- region/branch attribution when inferable from GPS.

Current storage target:

```text
Supabase Storage bucket: scans
```

Current observation fields:

- `original_photo_url`
- `watermarked_photo_url`
- `photo_url`
- `photo_captured_at`
- `photo_watermark_text`

### Evidence metadata lessons from old repo

Reference: old repo `docs/First-Security-Docs/NELSON_FREEDOM_CAMPING_EVIDENCE_METADATA_2026-05-17.md`.

Key findings to preserve in the new build:

- Storage object names and paths are not reliable for location or branch attribution.
- Embedded EXIF metadata is often the strongest linkage source.
- EXIF capture timestamp, GPS coordinates, and device make/model must be indexed when available.
- Region/branch attribution should be derived from GPS, not object path naming.
- Evidence can span multiple branches/regions in one bucket; ingestion must not assume a single client/region.
- Photos without EXIF/GPS require secondary enrichment, OCR, filename review, or manual triage.

Future evidence-index work should support:

```text
evidence_index
→ source bucket/path
→ EXIF timestamp/GPS/device
→ inferred region/branch
→ priority band
→ recommended ingest action
→ linked observation/session/report
```

This is important for reingest, historical import, branch-specific reporting, and defending evidence lineage.

---

## 5. ALPR hierarchy

```text
1. Local fcm-inference /infer/alpr
2. Plate Recognizer Snapshot API fallback if local ALPR fails or confidence < threshold
3. Manual officer plate entry
```

Manual entry must remain fallback only.

Plate Recognizer uses Supabase Edge Function secrets:

- `PLATE_RECOGNIZER_API_TOKEN`
- `PLATE_RECOGNIZER_API_URL`

No tokens in repo, docs, frontend, or migrations.

---

## 6. Overnight verification model

Primary evidence model:

```text
Evening photo scan before midnight
+ Morning photo scan after midnight
+ Same plate / zone / position
= Verified overnight stay
```

Midnight in `Pacific/Auckland` is the boundary.

Session states:

- `candidate_evening`
- `verified_overnight`
- `not_verified`
- `moved`
- `inconclusive`
- `manual_review_required`

The session table is:

```text
vehicle_overnight_sessions
```

Evening scans create candidates. Morning scans verify. Breaches should ultimately be actionable only after verified overnight evidence.

---

## 7. SCV lookup model

Primary source:

```text
canonical_scv
```

Loaded by official/approved CSV import.

Future fallback:

```text
NZSCV API via fcm-api proxy
```

Lookup order:

```text
canonical_scv CSV import
→ NZSCV API fallback when approved/configured
→ manual review / unknown
```

Expired certificates must not mark a vehicle compliant.

---

## 8. Reports and visibility

Officer actions must flow back to:

- admin.
- master.
- client portal where policy allows.

Minimum pilot reporting:

- scans by site/zone/date.
- verified overnight stays.
- breach alerts.
- compliance rate.
- incidents.
- CSV export.

Later:

- PDF reports.
- client dashboards.
- scheduled reports.

---

## 9. Officer reports

Standalone FC must include:

- incident reports.
- maintenance reports.
- health & safety reports.

Each should support:

- type/category.
- notes.
- severity.
- photo/GPS evidence.
- admin/master visibility.
- client visibility by policy.

---

## 10. Notices and print

Officers must eventually be able to generate/print on site:

- warning.
- Notice to Vacate.
- infringement draft/notice.

Legal/high-impact actions require explicit human confirmation/signature boundary.

Notice artifacts should be stored in:

```text
notice-artifacts
```

---

## 11. Bob role

Bob is advisory and contextual.

Bob may:

- explain verdicts.
- identify missing evidence.
- summarise observations.
- draft field notes.
- prepare notice wording.
- help review SCV import results.

Bob must not:

- silently override compliance.
- issue notices without human confirmation.
- alter canonical SCV records outside approved import/API workflows.

---

## 12. Current implementation sequence

1. Overnight session schema.
2. Scan pipeline session tracking.
3. SCV CSV import schema/function.
4. Plate Recognizer fallback.
5. Standalone scanner UI.
6. Evidence watermarking.
7. True scanner UX with Zoom/Detail modes.
8. Officer reports.
9. Notice draft/print.
10. Admin/client reporting.
