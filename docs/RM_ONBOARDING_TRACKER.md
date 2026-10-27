# R&M Security and Investigations — live-org onboarding tracker

R&M is FCM's first real customer. This tracks the effort to populate R&M's own
organization with its real client/site/zone/permit/patrol data, and — just as
importantly — to use that real data as an end-to-end proof that the app actually
works for a live operating org, not just that rows exist in tables. Update this
file as work lands; it is the durable, repo-committed record (session memory
under `/memories/session/rm-full-population.md` has more granular working notes
and is the detailed log this file summarizes).

Owner ruling basis: "seed all the sites and geo fence them and assign patrol
module and static [guarding] modules and other modules as needed, then backfill
the patrol log entries, ensuring that any reference to person or number plate is
enriched into the correct canonical records... make sure the entire build can
actually work with a working org and its data and operations." Extended-scope,
multi-session task — take as many turns as needed; real, verified progress each
turn beats false completeness.

## NEXT: RECORD/PHOTO AUTOMATION, THEN OFFICE CLIENT WORK (2026-10-26)

- Owner priority: finish importing new and changed records and photos before
  building the office time-entry surface. The existing laptop source scanner
  detects workbook/photo versions but still reports `promotion: not_connected`.
  Versioned record reconciliation and photo matching/attachment exist separately;
  their presence is not proof of an unattended end-to-end import.
- Preserve the approved add/update policy: retain source path, workbook
  sheet/row, content hash, prior versions and audited receipts; never delete
  business records merely because a source row/file disappears. Acknowledge a
  queued file version only after its exact path/hash has an applied receipt.
  Ambiguous photo links, unmapped places and conflicting FCM/source edits must
  remain visible holds, not guessed matches or successful imports.
- Built (branch `feat/rm-source-promotion`): `services/document-source-worker/
  source-promote.mjs` connects the scanner to the versioned writer and photo
  importer, using the reviewed map `rm-patrol-source-map.json` (14 workbooks
  mapped, 8 held; duplicate "Issue" headers carry reviewed per-sheet
  `column_aliases`, following NCC's approved `Secondary Issue (U)` precedent).
  Workbook rows are exported with narratives and synced evidence-only, so no
  Workshop proposals are created. Default mode is a dry run; `--commit` writes.
  A governed RPC refusal becomes a visible hold; a transport failure stays
  pending for retry. A single lock file prevents overlapping runs.
- Live workbook dry run (2026-10-26), nothing written: about 788 new rows
  (MR 27, OFO2025 65, OFO2026 350, STAND 12, TDC 198, TPFL2026 135, TAYLORS 1).
  OFO2026's 350 rows exceed the 250-row change-volume guard and are held for
  review. About 9,000 legacy rows would gain source provenance; this adopts
  provenance and adds no new data. Rows linked to finance costs stay held by
  the server. NCC is refused because some new rows are at places outside the
  contracted patrol coverage, which needs review. Rows with an unexplained
  difference from source (notably about 9,600 across the OFO workbooks) remain
  untouched holds.
- **Legacy importer artifact correction (2026-10-30, migration
  20261030140000):** about 21,000 imported rows had no source version and were
  held as `initial_difference_requires_review`. Profiling showed known
  legacy-importer artifacts: `occurred_at` stored exactly 1h late in NZDT months
  (a fixed +12 offset; the sheet parser uses Pacific/Auckland), float noise in
  `job_time_hours`, and payloads missing provenance/classification keys. Owner
  ruling: the spreadsheets are source truth and history is preserved.
  `correct_legacy_patrol_source_records` now corrects events and observations
  from the same workbook/sheet, writing version 1 `legacy_correction` and an
  audited `patrol_legacy_source_corrected` entry. It also moves an observation's
  `observation_trigger` context event to the corrected time. Uninvoiced finance
  cost rows no longer block a correction that keeps the record's local service
  date (the cost row's date and amounts stay true). An invoiced record, or one
  whose local date would move, stays held. Live run (attempt 2): **18,902
  corrected** (including 1,944 observations, with 1,944 context events moved)
  and **2,018 held** for genuine content differences: status, zone, officer,
  `event_type`, payload values or a time gap that is not the offset artifact.
  Those stay visible holds for reviewed adoption; possible key collisions (for
  example, two STAND rows) must not be adopted automatically. A post-run check found no
  finance service date moved by the correction (34 pre-existing date
  mismatches, unchanged). Review fixes (migration 20261030150000): a stored
  object key that the sheet lacks is now a payload-difference hold, and an
  observation's context event must have no continuity, incident, evidence or
  access link before it moves. A retro check showed neither case occurred in
  the live run. An event photo whose hash already belongs to another record is
  a visible hold, not an applied receipt.
- **Photo download hazard:** 72,543 of 76,156 R&M photos (424.7 GB) are
  OneDrive online-only placeholders. Hashing them downloads them. The laptop
  scanner container's `SOURCE_SYNC_INCLUDE_PHOTOS` is now `"false"`, and photo
  promotion is name-first: listing, metadata and filename matching never read
  file bytes. Only a photo that uniquely matches one record is read and
  attached. Its receipt is keyed by size and modified time, so it is not re-read.
- Live photo dry run (2026-10-26, before event fallback), no bytes read and the local footprint is
  unchanged at 3,613 files: 396 unique matches, 19 ambiguous, 11,151 unstructured
  filenames, and 47,029 with no exact record match. The low match rate is a
  matching-rule question for review, not a reason to guess links.
- Owner photo rules (2026-10-26): a photo whose structured filename date/minute
  matches a record is attached to it; a structured photo with no match should
  become a new observation (phase 2, needs a reviewed folder-to-place map for
  the 440 "Place - Area - Client" folders and a governed creation path, not yet
  built); photos without the structured `YYMMDD HHMM[SS] [rego]` name are
  ignored (`status: ignored`, not holds). Matching now also falls back to R&M
  patrol `location_events` when no observation matches.
- Photo attachment runs as the `rm_patrol_log` source profile's configured
  import identity (the same governed actor as the record writer) via
  `attach_external_photo_to_record`; no importer password is needed. File
  metadata goes into the source note as provenance (for example, "no camera
  EXIF, consistent with a CCTV screenshot or export"). Rollback check: the
  import identity passes `org_access_allowed` for every R&M client org; the one
  refusal is Downer/LINZ, outside R&M's operational agreements, so any match
  there is refused, not forced.
- NCC coverage: four NCC zones (Branford Park, Neale Park, Peppertree Park and
  Queens Garden) were linked to the R&M NCC operational agreement through
  `manage_crm_agreement_zone_coverage` (audited `crm_agreement_link_zone`), so
  rows at those places can be written.
- NZTA photos stay on the existing governed MVR workflow: OCR proposes person and
  vehicle facts, and an org admin approves each one in Identity Records before
  canonical people and vehicles change.
- Scheduling: `scripts/run-rm-source-promotion.ps1` runs the promoter with
  `--commit --photos`, fetching the service key from the linked CLI at runtime
  (never stored) and logging each run to the state directory. Windows task
  "FCM R&M source promotion" runs it daily at 7pm (owner choice), with
  `-PhotoLimit 200`, `StartWhenAvailable`, a 3h limit and state in
  `%LOCALAPPDATA%\FCM\rm-promote`. Two unattended-run defects were fixed and
  verified with a triggered run (`LastTaskResult 0`): Windows PowerShell 5 had
  treated the CLI's stderr update notice as fatal, and outside an agent session
  `supabase db query` returns a bare row array instead of the
  `{ boundary, rows }` envelope (`cliQuery`, `import-patrol-log` and the labour
  preview now accept both).
- Photo phase 1 (2026-10-26), name-first matching with event fallback: 847
  unique matches, 31 ambiguous, 46,566 with no exact match, 11,151 unstructured.
  Of 320 committed so far, 17 were new governed attachments
  (`external_photo_attached` by the import identity, not court-ready), 301 were
  already attached on 2026-10-11 and reused idempotently, and 2 were held because
  their hash already belongs to another record. 527 matches remain and drain at
  200 per nightly run.
- Owner decision (2026-10-26): the 2,018 held source content differences from
  the legacy correction are adopted from the sheet, audited with history kept.
  Invoiced rows, suspected key collisions and finance-linked rows whose local
  service date would move stay held. This needs a governed adoption path (not yet
  built).
- Seeded spreadsheet jobs remain accepted reporting/billing source truth until
  R&M operates in FCM, with no retrospective geofence requirement. This does not
  invent geometry, GPS attendance, a worker identity or a photo-to-job link.
- Deferred owner requirement: Sally performs CCTV review; she and other office
  staff need roster-backed work units and entries identifying the worker,
  client, time, relevant location and purpose. Ash's Habitat app-building work
  is another example. Keep client work distinct from internal office work and
  preserve each client's own billing terms.
- Implementation recommendation, not yet built: reuse shared office/internal
  work-unit and labour/time-entry paths rather than creating a permanent unit
  per named employee or forcing office work into patrol/Workshop execution.
  Distinguish where the employee worked from the client's place being reviewed.
  Recording time must not automatically create a client invoice or field shift.
- Owner classification clue: no kilometres travelled is a useful indicator of
  office-based work for the client, including CCTV review. Interpret explicit
  recorded zero kilometres as supporting evidence alongside the description,
  activity and source performer. Blank, missing or invalid kilometres are
  unknown, not zero. Zero kilometres alone does not prove office work: static
  duty and on-site repairs can also involve no travel. Do not assign all such
  work to Sally or reclassify already seeded records without source evidence.

## R&M GROUP CHARGE CODES (2026-10-25) - APPLIED, PR STACKED ON #190

Owner decisions: OneFortyOne numbers are the group standard; Mainland Pest
Control (an R&M subsidiary) numbers are used for pest-control jobs; logic
assigns every other code. "Removal" means removing a covert camera or CCTV
device. Gate and sign work is engineering (maintenance or manufacture) unless
the row only reports a gate open/live or closed/dead, which is patrol
reporting. Equipment and materials are separate dimensions; ammunition is a
material recorded with its calibre.

- Migration `20261024233829_rm_charge_code_catalog.sql`, applied and
  live-verified (`supabase/tests/20261024233829_rm_charge_code_catalog.sql`);
  `schema.sql` regenerated.
- Code = source digit + two-digit subject + two-digit issue (OFO scheme):
  4 sources, 29 subjects (new ones from 27), 100 issues (new ones from 76),
  421 codes. OneFortyOne's List sheet has 269 code rows; Security | General |
  Intel (41535) appears twice, so 268 distinct OneFortyOne codes are
  reproduced unchanged, plus 153 derived codes.
- Scope (owner choice `rm_group`, migration
  `20261024235708_rm_group_charge_scope.sql`, applied and live-verified): R&M
  owns the catalog; R&M's tree (including Mainland) and every active
  operational client of a tree member hold synchronised copies. 35
  organisations live, 19,390 rows. New children and agreements are seeded by
  trigger.
- Labels resolve through aliases (plurals, typos, "- company" to "- R&M") and
  combination aliases (Gate Live/Dead to Open/Closed, camera Removal to
  Uninstall 40570/30570, Lock "E-Lock ..." to the E-Lock subject).
- Pest codes carry the real OneFortyOne client GL where the MPC log evidences
  it (Goat 3609, Ammunition 3606, Monitoring 3758, others 3615). Each species
  has its own charge code; there are no per-species GL numbers. Derived codes
  default to Extra (owner ruling 2026-10-25, migration 20261025091600).
- Mainland Pest Control (owner choice `mainland_parent=true`) now has
  `parent_organization_id` = R&M (level 2). R&M masters/admins reach it by
  tree descent; Mainland users gain no upward access. Ruling recorded in
  `docs/canon/ORG_SERVICE_MODEL.md`.
- New catalog types: `equipment_type`, `material_type` (ammunition with
  calibre, quantity, unit price). New activities `uninstall`, `manufacture`;
  new subject `sign`. Rules cannot target charge codes; the importer composes
  them (`scripts/patrol-charge-code.mjs`) and parses stated material use only
  (`scripts/patrol-materials.mjs`).
- Coverage: 38,631 of 38,642 observed workbook rows resolve. 11 stay
  unresolved for review (blank/#N/A subject, "Gates / Signs", "Keys / Locks
  /Pins"). DART 2026 plan: 1,105 of 1,105 rows catalogued.
- Sync impact: the row fingerprint covers derived payload keys, so the next
  sync versions or holds existing rows whose derived codes changed. Step B
  must separate derived reclassification from real source edits.

## DART BUSINESS-MODEL BUILD-OUT (2026-10-25) - STEP A APPLIED

Owner decisions: build all five steps in order (A codes, B legacy correction
and supersede, C animal outcomes, D stations, E finance), each as a reviewed
PR. Later owner clarification keeps the 2025 and 2026 records separate; do not
supersede one year with the other. Only uniquely matched `Update 251215` copies
may update and archive against the 2025 canonical records. Sites 1-11 are
mixed traps and cameras. Bait quantities are not recorded yet, so none are
inferred.

### Step A - pest-control vocabulary (PR #190, stacked on #189)

- Migration `20261024224750_rm_pest_control_vocabulary.sql`, applied and
  live-verified; `schema.sql` regenerated. It adds:
  - work_subject codes `pest_device`, `animal`, `habitat`;
  - work_activity codes `device_reset`, `device_unset`, `rebait`, `prefeed`,
    `removal` (work-order candidate), `device_inactive`, `access_blocked`,
    `cull`, `sighting`, `pest_patrol`;
  - a new `biosecurity_species` catalog, seeded to every organisation.
- R&M `rm_patrol_log` rules key on the labels from the master charge-code
  file (`Misc\MASTER`), never on charge-code numbers, because the numbers are
  renumbered between workbook versions.
- DART 2026 simulation: `other/other` went from 511 rows to 0. Animal rows
  now carry species.
- Existing events are unchanged. Step B reclassifies them through a governed
  correction with versions and audit.

### Step B - source corrections and paired Update rows: applied; resync verified

- Owner-approved Update scope: 304 one-to-one copies update their canonical
  2025 event and archive the copy atomically. Twelve copies colliding across
  three canonical targets and seven unmatched copies remain untouched. The
  official matcher was checked against the private source plans: 304 distinct
  canonical targets, 12 ambiguous holds, seven unmatched holds.
- Migration/test
  `20261029110000_patrol_legacy_correction_and_supersede.sql` passed the linked
  SQL behavioral truth table inside a rolled-back transaction. Coverage includes
  provenance, canonical job/cost/hour preservation, archive/replay, mismatched
  status holds, dependent-record holds, and no consequential proposal, finance,
  roster, timesheet or payroll records for the test organisations.
- Official rollback-only 2025 run: 681 legacy corrections, including the
  canonical correction for each of the 304 paired Update actions; 304
  `updated_and_superseded` results; 19 planner holds. No inserts or proposals.
- Official rollback-only 2026 run: 1,105 legacy corrections, no supersedes,
  inserts or proposals. The source-faithful reparse retains narratives and
  status; it has the same workbook and derivative hashes as the earlier plan.
  Jobs 793, 982 and 1068 correct to 43, 43 and 48 km with the original erroneous
  formula values and Start-row provenance retained.
- `reconcile-plan.mjs --apply ... --evidence-only` explicitly suppresses
  consequential proposals without suppressing source narratives/status. Use it
  for standalone correction runs as well as the paired Update run (which
  already suppresses proposals). `--apply` without `--commit` rolls back;
  `--preview-migration` is prohibited with `--commit`. Do not use
  `--canonical-plan` to collapse the separate year sheets.
- PR #215 review fixes (2026-10-29): the canonical's new version keeps its own
  2025 source identity and records the Update row separately as
  `overlay_source` plus a post-overlay `record_fingerprint`, so a later resync
  reads `unchanged` (or holds a changed source as
  `update_overlay_review_required`) instead of mismatching file/sheet. Copy
  time shifts are accepted only when zero or +1h during NZ daylight time.
  The generic supersede now holds year-sheet records
  (`source_year_records_remain_separate`), Update-sheet copies
  (`update_copy_requires_paired_path`) and cross-workbook copies. Repeated
  pairings are rejected both across planner chunks and server-side
  (`ambiguous_update_pairing`, `ambiguous_update_copy_group`). Blank Update
  values never erase canonical values. Both staging batches are finalised in
  one transaction, and a committed re-run recovers an open receipt.
- Re-verified after the fixes: SQL truth table passes in a rolled-back
  transaction; 2025 dry run 681 corrections / 304 `updated_and_superseded` /
  19 planner holds / 0 proposals; 2026 dry run 1,105 corrections / 0 holds /
  0 proposals.
- Owner approved the bounded release and committed corrections. PR #215 merged
  as `4e59ec0c`; the VPS release lane applied migration `20261029110000`.
  Generated catalog PR #218 merged as `647251ef`, and the next lane tick
  completed with matching schema and its Atlas refresh. No direct main push
  or local production migration writer was used.
- Committed batches (all finalised as `needs_review`, the import receipt state):
  - 2025 `e54ccb0e-926a-46cb-81e8-98458c11ad0e`: 681 corrections;
  - Update `7b8417db-5752-4c2b-bd35-4e27e474f8f9`: 304 paired updates/archives;
  - 2026 `613f25be-ddb8-4c66-80c3-0ba2575a45b5`: 1,105 corrections.
  Read-only verification found 1,786 correction audit entries, 304 paired
  audit entries and 304 archived copies. All three receipts record zero
  direct finance/workshop writes and have zero staged proposals.
- Post-commit replay exposed two planner bugs, not changes to the saved
  canonical records: an Update-only `charge_code_unresolved` key polluted
  every 2025 comparison, and floating-point distance artifacts differed from
  stored numeric precision on four rows in each year. The fix uses the same
  canonical field set on both sides and compares the complete current record
  to the version's `state_after`, exactly as the server update RPC does.
  Source fingerprints/history remain unchanged; genuine FCM edits still hold.
  Read-only preview now honors the same Update/copy inputs as the sync runner,
  and runner reports include planner hold reasons rather than presenting a
  held-only run as `no_source_changes`.
- Verified against live records with the resync fix: 2025 has 681 unchanged
  canonical records plus the original 12 ambiguous / seven unmatched holds;
  2026 has 1,105 unchanged records and no holds. Both runner checks request
  zero writes. Every current canonical version exactly matches its saved
  `state_after`. Focused importer/reconciliation tests: 45/45 passing.
  The resync fix was released in PR #219 (`6f87dbf8`). Main verification
  `40181416033`, protected GitHub Atlas refresh `40181809581` and Vercel
  deployment all succeeded. The earlier catalog-head runtime failure is not
  the release status of this fix.
- Rostering follows source reconciliation, not this correction transaction:
  forestry patrol pay is $32/hour; historical hours sum `job_time_hours` per
  officer/day. Unattributed jobs use the approved Relief Officer (No Name)
  identity. Engineer pay is $55/hour, distinct from the $79.50 client charge;
  digger hours/travel are equipment use, not labour. The $166.60 service amount
  includes time, travel and ammunition, not a per-person pay rate.

### Phase B - labour seeded and routed to patrol routes (2026-10-26)

- The labour seed is live: 3,520 completed slots, 8,610.4707 hours,
  $275,534.94 estimated pay at FORESTRY-PATROL $32/hour. It was released in PR #223.
  Historical slots are pay-only, with no second billable amount.
- Owner ruling: shifts belong on the Blenheim (Dave Porter) or Nelson (Dan
  Douglas) patrol route. Migration `20261030120000` records each route's usual
  officer and routes the seeded labour. Rollback result: 680 Blenheim and 2,840
  Nelson, none unrouted. By basis: 3,317 by place, 64 by dated route assignment
  and 139 by the officer's usual route. 49 coverage zones were added and the 14
  per-client holding units closed. A fresh import and a live replay give the
  same split. The import script now routes once, after every batch.
- Owner ruling: seeded spreadsheet jobs are verified source truth with no
  geofence requirement. Rollback: the 22 seeded slots in the current 62-day
  readiness window change from three `pending_materialization` exceptions to
  `source_verified`. The wage rule is unchanged.
- Atlas and schema check: routing reaches the roster calendar and the route
  coverage list only. Payroll exports read timesheets, and patrol billing reads
  the patrol log, so neither moves. No function that builds future patrol stops
  reads `patrol_route_zones`.
- Data anomaly, not corrected: the Bartletts (OFO) place is geocoded at
  longitude 177.87, which is outside the patrol region. The geocode needs a
  review.

### Phase B - historical labour readiness, not posted

2026-10-25 continuation (local implementation; not deployed):

- Removed the separate forestry-history table. Source assignments are projected
  into the normal calendar by exact work date/officer and patrol-route/work-unit
  link. Source time ranges are explicitly not payable hours. Canonical completed
  labour slots show provenance in the same staff/work-unit calendars and replace
  source cards for the same roster staff/day.
- Planner v2 holds missing/invalid-hour and over-24-hour days as evidence,
  resolves supported name variants/staff accounts, and uses the approved
  non-login Relief Officer placeholder for unnamed labour. Latest rollback:
  3,520 planned/inserted slots, 8,610.4707 hours, $275,534.94 estimated pay,
  no second billable amount. All writes rolled back; no labour seed is live.
  240 held groups and 3,062 evidence-only groups are not posted.
- Owner requested Manufacturing & maintenance in Create work unit and clarified
  that these jobs must belong to a client, linked to Workshop work orders. Added the
  distinct `workshop` roster category, governed organisation-scoped order link,
  provider workplace/team/cost centre, and open-order prerequisite. Order kind
  supplies the service code; roster staffing does not change the job lead.
  Work-order execution/invoicing stays in Workshop, not a duplicate patrol or
  roster billing flow. The new migration is pending the governed release lane.
- Client-only roster choices now match the RPC requirement. The empty state
  opens client-job creation; generic internal fabrication remains available
  separately in Workshop. Keyword classification is explicitly applied by the
  user and resolves only active catalogue codes (digger work maps to the new
  `earthworks` subject; orgs without it must choose manually). The usual job
  lead comes from `workshop_settings` (seeded with Pete Crawford for R&M,
  changed only through audited `set_workshop_default_job_lead`) and is offered
  as an explicit choice only when that person is active in the operating
  organisation; no automatic historical assignment, attendance or payroll is created.
  These are local changes, not a migration/deployment or seed receipt.
- Latest continuation verification: 32/32 fixture browser checks passed on
  desktop/mobile (including officer Workshop, client-backed work-unit creation,
  source-calendar placement, classification/manual overrides, missing catalogue
  codes and unique/ambiguous/cross-organisation lead suggestions). App and
  browser-test typechecks, 44 focused roster/classification tests and 28
  historical-labour planner tests passed. A scoped aggregate live read found
  exactly one non-deactivated Pete Crawford profile in R&M. The migration ledger
  contains neither `20261029120000` nor `20261029130000`; production application,
  labour seeding, schema regeneration and Atlas refresh are still pending.
- Database rollback acceptance passed for creation/audit, duplicate and
  unknown-order/workplace denial, publish/cancel without a field shift,
  no duplicate billable amount, draft/closed-order blocking, anonymous grants
  and unauthenticated denial. This is rollback evidence, not a live deployment
  or an exercised-production claim. Schema regeneration and Atlas refresh follow
  application through the production migration lane, not hand edits here.
- Browser acceptance: 12/12 desktop/mobile checks pass for manufacturing and
  maintenance creation, missing-order guidance, explicit RPC errors, normal
  source-calendar placement and suppression of duplicate posted-labour cards.
  Fixed the mobile category label to wrap rather than overflow the dialog.
  Typecheck, 30 focused roster tests and 28 labour-planner tests pass. Browser
  checks use synthetic fixtures, not production invocation evidence.

- Added the read-only `scripts/preview-rm-patrol-labour.mjs` and its behavioural
  planner tests. Run with `--from YYYY-MM-DD --to YYYY-MM-DD --output <private
  JSON outside the repository>`. There is deliberately no `--apply`. The
  linked query runs in `BEGIN READ ONLY` / `ROLLBACK`, scopes clients through
  R&M's provider agreements, uses Auckland work dates, and checks current
  source versions for FCM edits. Output stdout is aggregate-only; the private
  report retains record IDs, source references, available file/hash/row/version
  provenance, daily groups and deterministic fingerprints.
- Live readiness window 1900-01-01 through the database's current Auckland
  date, 2026-10-25: 33,318 source records; 5,779 officer/date evidence groups
  (including unattributed groups); 2,472 candidate groups, 794 evidence-only
  groups and 2,513 held groups after the owner's explicit-zero ruling.
  Four future-dated records are outside the window, including a year-2926
  anomaly; none were corrected or imported by this check. No earlier records
  were omitted. Full-source replay reproduced the same report/fingerprints.
- The planner sums source job hours exactly, never first-to-last elapsed
  windows. $32/hour is an owner-approved preview policy, not a resolved live
  pay rule. The `FORESTRY-PATROL` pay code does not exist live yet. The existing
  3,055 historical assignments have no pay-code metadata; the existing
  `get_roster_labour_cost` reads scheduled slots, not these historical
  assignments. Do not claim that historical pay is already wired.
- Holds overlap: 1,595 groups contain missing/invalid hours;
  978 need officer-identity review; 36 exceed
  24 recorded hours without clipping; 45 have conflicting source identities;
  40 have possible same-job/day overlap across year sheets; five need source
  reconciliation review. Conservative narrative markers additionally flag
  57 groups for engineering and 116 for equipment review, plus one crew
  attribution review. Those markers are review prompts, not proven job
  classifications or authority to apply an engineer rate.
- Owner confirmed explicit-zero policy: zero contributes zero to the daily
  sum, and all-zero days remain evidence only with no pay-code assignment or
  pay estimate. Blank/invalid hours still hold the entire day, not a partial
  payable total. Of the 3,357 groups containing zeros, 1,536 mix zero and
  positive entries; 1,498 contain only explicit zeros. Other holds still apply:
  not every all-zero group is clean evidence-only. The approved policy removes
  1,886 zero-only holds: 1,092 become candidates and 794 become evidence-only.
- Matching event/observation manifestations of one source identity are counted
  once while both record IDs remain in provenance. Conflicting manifestations
  hold; year sheets remain separate records and possible payment overlaps
  hold rather than being silently collapsed. No anonymous group is payable:
  the approved Relief Officer (No Name) identity still needs a governed
  representation, not a fabricated login.
- Atlas upstream flow reach for `roster_assignments` found four component and
  two RPC nodes at depth two. Eleven direct FK-reference edges are separate
  structural evidence, not extra proven flow. No schema, Atlas, roster,
  timesheet, pay-code, payroll, invoice or notification writes were made.
- Next: resolve the retained holds and historical
  labour storage/reporting path; then build and rollback-test a governed seed
  with exact insert/update/hold counts for bounded owner approval. This
  readiness report is not that seed or an authorization to post payroll.

## PATROL SOURCE ROW SYNC (2026-10-25) - APPLIED (PR #189), LEGACY CORRECTION IS STEP B

Owner requirement: "if a row has been updated, it will need to be updated in
fcm as well so we need to know if a row was updated."

### Design

- Migration `20261024214047_patrol_source_row_sync.sql` adds the append-only
  `patrol_import_record_versions` table (one current source version per
  record; history kept; RLS read for provider import admins only) and two
  governed RPCs run as the configured import identity:
  `adopt_patrol_source_baseline` records the first source version for an
  imported record, and `apply_patrol_source_updates` applies a changed source
  row with a new version and audit entry (field names only, never values).
- Updates hold instead of overwriting when: there is no baseline, the
  comparison is stale, FCM was edited since the last sync, the new place is
  outside contracted patrol coverage, another batch has an open proposal for
  the record, or a locked observation would change its evidence fields.
  Locked-observation edits to non-evidence fields (for example distance) still
  apply. Rows missing from the source are never deleted.
- `reconcile-plan.mjs --apply --source-plan <plan> --provider-org-id <id>
  --output <report>` runs each workbook version as one sync batch: stage new
  rows, adopt baselines, apply updates, finalize with a zero direct
  workshop/finance write receipt. Default is a rolled-back dry run;
  `--commit` writes; `--attempt n` re-runs after holds are resolved;
  `--preview-migration` dry-runs against the migration before it is applied.
- The importer's `--export-plan` output now includes the batch definition the
  sync needs.

### Verification

- SQL behavioural truth table `supabase/tests/20261024214047_patrol_source_row_sync.sql`
  passed against the linked database inside a rolled-back transaction, with a
  sentinel run proving the test reached its end; production confirmed clean
  afterwards. It found and fixed two defects: a locked observation's stored
  plate spelling tripping the lock trigger, and an applied proposal holding
  its record forever.
- 50 native client tests and 13 Docker scanner tests pass.

### Real DART dry run - legacy rows need an owner decision

- Dry run of both DART year sheets: zero writes, all 1,786 existing year-sheet
  events held client-side (1,783 `existing_source_identity_mismatch`, 3
  `invalid_source_distance`). The 2026-09-23 importer stored no source file,
  sheet, or row provenance and an older payload shape.
- Field-level comparison against the current workbook (counts only): every
  difference is a legacy importer artifact, not a workbook edit.
  - `occurred_at`: 1,362 events one hour late, all in NZDT months; NZST months
    match. The legacy importer applied a fixed +12 offset.
  - `distance_km`: never populated by the legacy importer.
  - `status`: narrative-disabled preview plans leave status empty. A
    source-faithful correction must opt into narratives/status and suppress
    proposals separately; the fresh Step B preview above verifies this.
  - 20 current payload keys (provenance, classification, cost) are absent.
- Earlier comparison identified 681 matching visits across `DART2025` and
  `DART2026` references. Matching is not authority to supersede: the later owner
  ruling keeps both year sheets distinct. The Update-copy scope and fresh
  correction evidence above replace the earlier cross-year supersede proposal.

## IMPORT AUTOMATION RESUMPTION (2026-10-25) - RECONCILIATION GATE OPEN

Owner requested this order: patrol spreadsheet automation, company document
intake, photo linking, then whole-pipeline verification. These are separate
completion gates; the inventory and running scanner do not prove promotion.

Owner clarification in the same session supersedes the interim "new-only"
choice: source row edits must be detected and propagated to FCM as well as new
rows. Use stable job identities and source-content fingerprints, preserve
history, and hold conflicting FCM edits. No new-only migration was applied;
the unused empty migration scaffold was removed.

### Before: live, scoped read verification

- The laptop source scanner is running with a read-only source mount and a
  separate persistent state volume. Its latest receipt finds all 22 workbooks
  available and unchanged, with 22 pending versions and
  `promotion: not_connected`. The inspected scan does not include photos.
- The approved tenant-bound source alias is active. Its completed inventory
  contains 140,826 entries and zero recorded failures. There are 13,777 entries
  marked `ready_for_extraction`, but all still have
  `extraction_status=not_started`. Inventory is not extracted or imported data.
- Atlas confirms the patrol staging path and its agreement/place checks.
  Proven flow reaches the importer, source profile, activity, and contracted
  place/module checks. FK adjacency to finance receipts and review tables is
  structural evidence only, not proof of automatic updates.
- The schema explicitly rejects changed immutable provenance in
  `stage_patrol_import_chunk`. No versioned reconciliation writer is connected
  to the running scanner.

### During: real workbook defect and local repair

- The first fresh DART XLSX plans skipped all 911 rows in `2025` and all 1,254
  rows in `2026`. ExcelJS decoded the date cells as JavaScript Dates, but the
  reader returned their default text, which the date parser did not accept.
- The XLSX reader now emits ISO values for typed and cached-formula dates.
  The parser accepts those values, native Excel time fractions, seconds, and
  midnight zero while retaining Auckland DST checks. Synthetic tests cover
  both Excel date systems, cached formulas, numeric times, invalid clocks,
  source hashes, exact selected sheets, and original row numbers.
- Reconciliation now compares status, observed entity type, and measured
  distance as well as the existing source-managed fields. Nullable fields
  normalize consistently across rows. Duplicate checkpoints, mismatched
  checkpoint record/source identities, missing keys, and invalid distances
  are held. Old checkpoints without record/source bindings require review;
  they must not be silently upgraded into update authority.
- A source version cannot be acknowledged while unavailable or still saving.
- The existing reconciliation command can now load a linked baseline through
  explicit read-only transactions. It verifies the provider/client patrol
  relationship and reads exact incoming references in chunks of 200. It
  writes only a local JSON report, never activity, checkpoints, or finance.
  Source rows and skipped/unresolved counts remain visible in its summary.
- Source-to-source comparison now separately classifies baseline, added,
  updated, unchanged, missing, and held job keys. It reports changed field
  names without printing field values. Workbook hash changes, row movement,
  and derivative hash changes alone do not count as row edits. Provider,
  client, source file/sheet, profile, and key namespace must agree; changed
  extraction configuration is held rather than passed off as a source edit.
  First observation of a source creates a comparison baseline, not authority
  to replace a legacy FCM record. A missing row never requests deletion.

```powershell
node services\document-source-worker\reconcile-plan.mjs `
  --source-plan <local-plan.json> --linked `
  --provider-org-id <approved-provider-uuid> --output <local-review.json>
# Add --previous-source-plan <prior-plan.json> to identify source-row edits.
```

### After: verified result, not an automatic cutover

- Corrected DART `2025` produces 681 mapped activity candidates, all held
  because the legacy records lack the matching source identity.
- Corrected DART `2026` produces 1,105 mapped candidates: 1,102 legacy
  source-identity holds and three invalid source-distance holds. Both previews
  find zero new keys to insert. The separate `Update 251215` sheet was not
  replayed.
- Initial provider-bound source snapshots for both year sheets are saved
  locally for later comparisons. A self-comparison confirms 681 and 1,102
  unchanged valid source rows, respectively, with the same three invalid
  distance holds. This is an initial comparison baseline and serialization
  check, not evidence about historical edits or authorization to update the
  matching legacy FCM rows.
- Linked diagnostics used the existing approved CLI credential class and
  provider/client scope. No credential values or source narratives were
  printed. No business records, original workbooks, finance records, or
  scanner acknowledgements were changed.
- Validation: 43 native parser/reconciliation/contract tests and 13 isolated
  Linux scanner tests pass. Native Windows cannot create the symlinks used by
  two scanner tests without additional privileges; the Linux run exercises
  those checks rather than skipping them.
- This code is a local repair and row-change preview capability, not a
  deployed writer. The next gate is the audited legacy-baseline/correction
  path and versioned writer with history and conflict holds. Company-document
  extraction, ongoing photo import, and integrated cutover remain pending in
  the owner's requested order.

## LAPTOP SOURCE INVENTORY (2026-10-20) - VERIFIED, AUTOMATIC PROMOTION STILL OPEN

- PR #130 released as-attended patrol setup and actual measured between-stop
  travel through main commit `4ca8904979753816d7f21abeab122303f62f8897`.
  Both migrations are live, their rollback-only behavior checks passed, and
  Vercel reported a successful deployment status for that commit.
- The laptop review area contains 22 hash-verified workbook snapshots and
  22 completed Markdown conversions. Original workbooks were not changed.
  Metadata-only inventory found 83 worksheets and 27 candidate activity sheets
  across all 22 workbooks. The importer recognizes every candidate header and
  finds job, patroller, date, and a place-key column in each; that is only a
  layout compatibility check, not approval of row values, client ownership,
  agreement coverage, place mappings, or business promotion.
- The first inventory searched only 20 rows and missed Operation Lizard's
  actual `2025` and `2026` headers. The bounded search now checks the first 300
  rows and finds both headers at row 266, consistent with the earlier workbook
  audit. Its differently structured `Update 251215` sheet remains outside the
  generic detector and requires its reviewed sheet-specific handling.
- CommunityCameras installation/maintenance, digger work, pest control, culling,
  and overlapping historic sheets retain their proper governed workflows even
  when their headers resemble patrol logs. MPC still requires an exact
  agreement and reviewed place map.
- `scripts/export-patrol-workbook.py --inventory` records workbook hash, sheet
  dimensions, and recognized header positions without exporting business rows.
  Unmatched sheets return no raw header values: opening rows may be preambles
  or actual records. Normal derivative export still requires an explicitly
  selected sheet and header row; inventory does not authorize promotion.
  The tool refuses output replacing its source workbook and detects source
  changes during inventory.
- Three focused Python tests passed: metadata-only inventory including a row-265
  header without exposing preamble or activity values,
  existing formula/duplicate-header export compatibility, and missing-sheet
  and source-overwrite rejection. With the existing patrol import dependencies:
  `python -m unittest discover -s test -p 'test_patrol_workbook_inventory.py' -v`.
- A provider-scoped, read-only check compared these workbook names and hashes
  with 120 `file_import_batches`: five latest batches are `applied` with exact
  name/hash matches; six have an exact filename but a different latest hash
  (five `applied`, NCC `needs_review`); eleven have no exact filename match.
  These are provenance-comparison results, not proof that those eleven have no
  imported records; historic labels can differ. Do not blindly replay changed
  hashes or overwrite existing activity. The current importer intentionally
  holds immutable-provenance changes pending a reconciliation workflow.
- The approved Photos folder contains 58,589 files with supported image
  extensions, counted by extension only. No image contents were read and no
  file names were returned. Identity/place matching and custody review remain
  separate from patrol-event import.
- A local `--export-plan` run used the existing DART client, active patrol
  agreement, reviewed zone map, and current importer catalog. For sheet `2025`,
  911 data rows produced 681 event candidates; 162 lacked dates and 68 had no
  mapped place. For `2026`, 1,254 data rows produced 1,105 event candidates;
  60 lacked dates and 89 had no mapped place. Both plans produced zero
  observations and proposals. These were temporary laptop-only plans; no apply
  path was invoked.
- A local-only, ephemeral-HMAC comparison established exact key overlap:
  all 681 planned `DART2025` event keys already exist among 1,004 live keys;
  all 1,105 planned `DART2026` keys already exist among 1,105 live keys. The
  additional 323 `DART2025` keys match the previously applied `Update 251215`
  sheet. There are zero new DART event keys to insert from these two year sheets.
- Key equality does not prove that source-managed fields match or authorize
  corrections. Existing records have legacy/source-hash provenance boundaries;
  the DART sheets remain held until content fingerprints and provenance can be
  reconciled through an audited correction path. No DART plan was applied.
- Atlas refreshed from merged main commit `8fa8e794f06e79ed83442f07cd84436d0d95dd20`
  with zero capability/edge upserts and zero retirements (1,417 capabilities,
  8,215 edges). This is map freshness evidence, not a claim that every mapped
  feature has been exercised.
- After PR #135, Atlas refreshed from main commit
  `97577c0e5330f7476606a6fa13a6c31c35b49cb2`: zero capability/edge upserts and
  one stale edge retired. The retired edge claimed `ClientSetupPage` calls
  `manage_crm_agreement_setup`; current code routes schedule setup through
  `manage_crm_agreement_delivery_schedule` and as-attended setup through
  `manage_crm_as_attended_patrol`. Atlas still records the setup RPC call from
  `CrmAgreementSetupDialog`. Production deployment for #135 succeeded. No schema
  changes or migrations were needed.
- Still open: reviewed source mappings, all-client missing-place reconciliation,
  versioned row receipts/corrections, legacy-provenance review, photo promotion,
  and laptop scanner activation. The local detector remains disconnected from
  business promotion. Automatic spreadsheet-to-FCM sync is not enabled.
  Preserve history, hold conflicts, never automatically delete records, and
  keep finance approval separate.

## PAY, TRAINING, SKILLS, AND FINANCE OPERATIONS (2026-10-18) - READY FOR RELEASE

### Expected versus present

- **Before:** an administrator should be able to define a human-readable
  payroll role, assign it to staff, choose a governed payroll export code on a
  branch pay rule, and see the resolved role, rate, and pay code reach finance.
  Staff qualifications should be current, auditable evidence that can be used
  by rostering rather than free-text notes.
- **Present before repair:** R&M had 25 staff profiles, no active payroll role
  codes, no staff role assignments, two active pay rules, no managed pay-item
  reference codes, no staff skills, no training records, and no labour-cost
  postings. The role-code form rejected names containing spaces through native
  browser validation without durable guidance. Pay rules accepted unmanaged
  free text, and finance did not consistently follow the selected operating
  branch.
- **Missing:** a managed pay-code workflow, cross-screen setup readiness,
  training renewal lineage, duplicate-safe canonical skill assignment, and a
  visible branch-to-finance resolution receipt.
- **Contradictory:** Atlas marked the relevant rate-rule paths as wired, while
  live records showed no managed pay-item catalog and no exercised
  training/skill evidence. The live `reference_codes` constraint already
  defines payroll export categories as `pay_item`; an initial `pay_code`
  implementation failed the rollback-only migration test and was corrected to
  use that canonical schema type.

### Before, during, and after

- **Before:** payroll operations require an active role code, a staff
  assignment, an active managed pay item, a selected operating branch, and
  current skill/training evidence. Approved work remains blocked from finance
  when no pay rule resolves.
- **During:** privileged RPCs enforce tenant administration, code validity,
  active references, effective rules, idempotent training requests, immutable
  renewal lineage, and duplicate-safe skill updates. The UI distinguishes
  payroll role, payroll pay code, and branch pay rule, and surfaces missing,
  fallback, and ready role coverage.
- **After:** the rate register shows both role and pay-code evidence; training
  renewals preserve prior records; current skills remain tied to the canonical
  roster catalog; and labour-cost review follows the selected operating branch
  while showing the resolved role, rate, and pay code before governed posting.

### Verification

- The migration executed against the linked live schema inside a transaction
  and rolled back successfully; no verification records or schema changes
  persisted.
- Five focused guard files passed 41/41 tests.
- Rate Rules and People/HR Playwright coverage passed 54/54 tests across
  desktop and mobile Chromium after visual baselines were intentionally
  regenerated for the changed workflows.
- Trackforce was used only as workflow evidence: qualification-aware
  scheduling, explicit exception queues, and field-to-payroll traceability.
  FCM retains its own tenant, place, evidence, and custody doctrine.

## PATROL WORKBOOK FINANCE BACKFILL (2026-10-18) — APPLIED AND LIVE-VERIFIED

- Audited the read-only R&M patrol-log corpus at `Patrol Log Entries/All Log
  Spreadsheets`: 48 workbooks, 175 worksheets, and 938,094 formula cells. The
  original operational seed preserved some displayed cost values as source
  evidence but did not create governed finance records. Whole-workbook totals
  cannot be imported directly because active, archive, restored, and historic
  files overlap.
- Added a formula-aware local derivative exporter and finance staging CLI.
  Every derivative records the source file/hash, derivative hash, sheet, row,
  displayed values, and formulas. Files remain local and read-only; no workbook
  or extracted row value is committed, uploaded, or sent to an external model.
- The accounting model separates row provenance from ledger aggregation:
  positive `Job Cost` becomes `labour`, positive `Travel Cost` becomes
  `vehicle`, and `Total Cost` is reconciliation evidence only. It is never
  imported as a third line. `file_import_finance_cost_rows` retains every
  source fact while `finance_service_costs` receives one reviewed
  agreement/month/component line.
- The governed workflow is intentionally multi-step: stage source rows,
  confirm the exact import-profile mappings, review aggregate counts and
  totals, approve the batch, then explicitly apply it. Approval alone creates
  no business record. Final apply creates only missing monthly draft P&L
  periods, refuses locked/closed/overlapping periods, links every contributing
  row, records audit receipts, and is replay-safe.
- Removed the former one-proposal-per-row finance path from the operational
  patrol importer. Workshop candidates still use the existing proposal lane;
  all patrol finance now has one authoritative aggregate review/apply path.
- The reviewed active set is 15 sheets: 39,557 workbook rows and 32,159
  positive cost-component receipts. Local validation marked 29,956 components
  eligible (NZ$994,597.00) and quarantined 2,203. Live contract, place, and
  evidence revalidation added 924 correct quarantines: 506 lacked a matching
  operational-evidence record and 418 fell outside contracted places. That
  explains the full NZ$66,729.73 difference between local and server totals;
  no value was silently dropped or rounded away.
- Every active sheet completed bounded rollback preview before persistence.
  The server accepted 29,032 component receipts totalling NZ$927,867.27 and
  retained 3,127 quarantined receipts totalling NZ$185,000.53. Quarantine
  reasons are explicit: 2,120 unresolved contracted places, 506 missing
  operational evidence, 418 outside contracted places, 48 duplicate external
  references, 24 displayed-total mismatches, and 11 invalid service dates.
- After owner review of the redacted aggregate and quarantine report, all 15
  batches passed exact profile confirmation, aggregate finance review, batch
  approval, and explicit final apply. Live readback proves 501 unique
  `patrol_log` service-cost lines totalling NZ$927,867.27, 60 draft P&L periods
  created for covered months, 29,032 linked applied receipts, zero unapplied
  proposals, zero unlinked applied receipts, and zero duplicate source
  references. Quarantined receipts remain untouched and no cost value was
  written into client-owned observations or location events.
- The rollout exposed and closed four real tool/profile defects rather than
  bypassing them: repeated unnamed spreadsheet columns (#89), persistent batch
  rows passed as an invalid scalar subquery (#92), blank columns counted as
  required mapping reviews (#94), and the reviewed `Day of Week` header missing
  from the data-defined profile (#96). Each repair has a behavioural regression
  and was merged before the affected workflow continued. Live schema snapshots
  followed in #90, #95, and #98.
- Wrattens had an operational agreement but no enabled patrol module. The owner
  confirmed that its patrol workbooks are evidence of service scope; the module
  was enabled through `manage_crm_agreement_setup`, producing the normal audit
  receipt. All three Wrattens sheets then passed rollback preview and governed
  finance application without weakening agreement validation.
- Invoice-folder patrol extracts, archive copies, restored files, and the
  excluded MPC workbook were not promoted. Invoice copies remain reconciliation
  evidence only; MPC remains excluded because no exact client agreement and
  reviewed place map exist. Whole-file hashes remain version provenance, never
  economic identity.
- The final released schema is regenerated from the live catalog. Atlas was
  refreshed from exact merge SHA `00630483040b14bd3b022b97d96a85991197b17e`:
  the first marker-owned refresh retired one stale row and the immediate second
  refresh was idempotent (zero upserts and zero retirements). The patrol import
  RPC chain remains present and wired; `exercised` is not claimed because that
  Atlas field is not populated live.

## FINANCE VISIBILITY BUTTERFLY (2026-10-18) — RELEASED AND LIVE-VERIFIED

- Live verification found 61 draft P&L periods with costs, 501 provider-private
  cost lines totalling NZ$927,867.27, and no closed-period snapshots. The
  finance home read only `finance_pl_snapshots`, so it displayed “Not ready”
  and zero activity even though every period contained governed cost records.
- Added an administrator-only, read-only period summary over the existing cost,
  invoice, and P&L-period spines. The finance home now uses that summary for
  draft/locked periods, labels the result as changeable, and shows recorded
  revenue, costs, cost-line count, and current result without pretending the
  period is closed.
- The period-close snapshot path also omitted `invoice_count`, `gross_profit`,
  and `gross_margin_pct`. Closing now persists those derived fields atomically
  with the existing cost and revenue totals. A rollback production check
  created a complete six-line NZ$6,548.28 snapshot and then removed it.
- The CRM commercial roll-up treated every descendant client as though it were
  an operating provider, which produced rows of misleading zeros. Its scope is
  now the provider root plus actual branches. The last-30-day roll-up also
  reports internal service-cost count and total; those provider-private values
  remain absent from client-portal surfaces.
- Released through #102 and applied as migration `20261018140000`. Live
  authenticated readback returns the latest six cost lines, NZ$6,548.28 costs,
  NZ$0 revenue, and the explicit NZ$-6,548.28 draft result. The corrected
  provider/branch overview returns two operating organisations, 17 accepted
  agreements, and 16 current-period cost lines totalling NZ$50,606.29.

## STATIC-WORK CORPUS AND NMDHB SPINE (2026-10-18) — CONSOLIDATED, IMPORT REVIEW OPEN

- Read-only inventory covered 466 files under the 1080 operations folder, 284
  hospital commercial/tender files, 33 archived NMDHB operational files, 13
  current NMDHB safety-system files, and two current NMDHB operational
  workbooks. Hash manifests remain local and sensitive. Fourteen
  cloud-synchronised hospital tender files were unavailable during hashing and
  remain explicit gaps rather than success-shaped records.
- All 217 XLSX workbooks opened: 353 worksheets, 24 hidden worksheets, and
  38,618 formula cells. The source set contains real roster dates/times, staff
  identifiers, hours, travel, rates, invoice/payment evidence, work locations,
  1080 deployment roles, hazards, qualifications, and approval controls. It is
  not one import: commercial drafts, operational history, templates,
  superseded copies, safety controls, and tender evidence require separate
  governed lanes.
- Atlas/schema show that the shared static spine exists and is wired:
  `static_guarding` agreement modules, agreement places, roster work units and
  slots, shifts/stops, officer static-post RPCs, safety briefings, debriefs,
  labour costing, and finance service costs. Live R&M usage does not match that
  capability: one not-invited static agreement, one covered place, two work
  units, and zero slots, assignments, shifts, static stops, or static cost
  lines.
- The smallest blocking contradiction is NMDHB identity. The own-rooted,
  active government organisation is the canonical Model A account, while an
  inactive child prospect shell holds R&M's operational agreement, richer
  Nelson Hospital place/zone/contact, and static work units. The owner approved
  consolidation onto the own-rooted organisation while retaining the prospect
  shell as inactive audit history.
- Migration `20261018150000` implements that exact-ID guarded consolidation,
  retires the Layer-1 platform agreement's placeholder operational place, and
  deactivates the literal test work unit. It does not accept the client
  invitation, invent hospital posts, map staff names, or promote any historical
  source row. Those require separate reviewed agreement/place/person mappings.
- Released through #104 and live-verified. The canonical NMDHB account now owns
  R&M's operational agreement and the richer Nelson Hospital place/zone/contact;
  one real static work unit remains active, the platform placeholder link is
  ended, and one consolidation audit receipt exists. The migration ledger is
  converged.
- Capability classification after the audit:
  - **Supported:** formula-aware local workbook reading; canonical organisation,
    agreement, place, static work-unit, roster, shift/attendance, safety, labour,
    and finance spines.
  - **Partial:** historical hospital roster/hour/pay evidence and 1080
    shift/travel/cost evidence are parseable, but still need reviewed source
    profiles plus exact person, place, agreement-version, and rate mappings.
  - **Gap:** no governed static-history adapter currently carries those reviewed
    mappings into replay-safe roster slots/cost proposals. The 2021–2022 NMDHB
    records also predate the only R&M agreement (starts 2026), so that agreement
    cannot lawfully authorise their promotion.
  - **Exclude/quarantine:** current tender drafts, superseded and duplicate
    copies, test work units, the platform-billing placeholder place, unavailable
    cloud files, and any 1080 row whose client, deployment, staff, or mixed
    `static_guarding`/`biosecurity` scope is unresolved.

## INVOICE AND PRICE-BOOK CORPUS (2026-10-18) — INVENTORIED, NOT PROMOTED

- Located and read-only inventoried `Invoice Spreadsheets`: 70 files in 30
  folders, comprising 69 XLSX workbooks and one PDF. All 69 workbooks opened
  successfully. Their 90 worksheets contain 141,081 formula cells and 19,969
  nonblank rows. Full hashes, sheet metadata, header candidates, and formula
  examples remain in a local sensitive audit artifact; no workbook value was
  uploaded, committed, or sent to an external model.
- This folder is not one import source. It mixes at least four authorities:
  invoice/revenue documents, parts and supplier price books, patrol-cost
  extracts, and presentation/empty exports. These must map separately to
  `invoices`/`invoice_line_items`, versioned finance item cost and sell prices,
  patrol reconciliation evidence, or quarantine/exclusion.
- Thirty-two workbooks expose no nonblank worksheet cells and are excluded from
  record promotion unless a later governed extractor proves that an embedded
  object or external connection is authoritative. They must not produce
  success-shaped empty imports.
- Cross-corpus comparison proved that invoice-folder patrol extracts overlap the
  patrol source of truth. The OFO 2025 `A:U` operational/financial rows match
  the active patrol workbook for all 6,606 rows. The OFO 2026 snapshot shares
  2,159 economic rows with the active workbook and is an older partial snapshot.
  These sheets are reconciliation evidence only and must never create a second
  service-cost line.
- Duplicate invoice-area evidence also exists: the two Birdhurst workbook names
  contain identical sheets, and the two March OFO pest-control workbooks share
  multiple full sheets, including all 6,606 rows of the 2025 ledger. File names
  and whole-file hashes therefore cannot be used alone as economic identity.
- The safe next lane is invoice-native and review-gated: classify the document
  role, resolve provider/client/agreement, preserve source file/hash/sheet/cell
  provenance, reconcile subtotal/GST/total, detect cross-corpus patrol overlap,
  and propose either invoice headers/lines or versioned item cost/sell prices.
  No invoice, line item, catalog item, cost version, price version, payment, or
  P&L revenue record has been created from this corpus.

## LAPTOP SOURCE CHANGE QUEUE (2026-10-19, NOT LIVE RECORD SYNC)

- **As-attended patrols, 2026-10-20:** owner directed Dave Porter completions
  to the existing Blenheim Forestry Patrol and Dan Douglas completions to the
  existing Nelson Forestry Patrol. Added the policy at
  `scripts/data/rm-attendance-patrol-policy.json`. The bounded
  `scripts/seed-rm-as-attended-patrols.mjs` verified source-authored attendance
  across all existing imported clients: **89 Blenheim place links across four
  clients; 57 Nelson place links across five clients**. Rollback passed, applied
  all 146 links, and replay reused all 146. No shifts or visits were invented.
  This covers existing place-resolved imported records, not every unresolved
  row or every not-yet-processed workbook.
- Migration `20261020103000_as_attended_patrol_schedules` is live and in the
  ledger. The new governed `manage_crm_as_attended_patrol` reuses existing
  agreement/ownership checks, records route coverage and an explicit
  `as_attended_patrol` schedule with zero planned visits and no timing quota.
  `generate_shift_stops` excludes these configs. A rollback-only behavior test
  passed before and after deployment. The Client Setup option, route picker
  and plain-language portfolio summaries are implemented and tested locally;
  the frontend has not been released to production in this session.
- **Travel kilometres:** the parser now preserves source job-km values,
  trip-odometer values and their distinct column names, including the existing
  Stringer km header. It does not infer confirmed legs across source rows with
  unknown vehicle/run continuity. Migration
  `20261020150000_record_actual_patrol_travel` is live: measured kilometres or
  an odometer difference can be recorded against two actually attended stops
  in the same assigned shift, separately from `travel_distance_metres` route
  estimates. The writer requires the assigned active officer, rejects resets,
  stale corrections, skipped intermediate visits and unaudited direct writes,
  and provides idempotent audit receipts. Synthetic rollback tests passed
  before/after deployment; no invented actual travel was persisted.
- The officer travel-entry controls are implemented and tested locally with
  measured-km and odometer modes, receipts and failed-save handling. Current
  focused verification: 19 web tests, 35 import/policy tests, both live SQL
  behavior probes and the production build passed. Regenerated the schema from
  the live catalog. Local preview: `http://localhost:5173/`. Frontend release,
  the full missing-place pass for all workbook sources, and permanent automatic
  spreadsheet promotion remain incomplete; do not describe this as full sync.
- Atlas refresh was attempted after the live schema snapshot, but its safety
  guard refused retirement of 2,463 entries. The override was not used; this
  generated-map reconciliation remains a separate unresolved gate.

- **Verified NCC backfill, 2026-10-19:** applied 194 new activities through
  the existing governed import functions after a rollback-only probe. Batch
  `6309ae11-e434-4d9d-8dae-ccbdded4268a` is `needs_review`. Read-back confirmed
  194 persisted events, zero duplicate keys and two batch audit entries.
  Legacy records were not overwritten. The source snapshot was converted
  locally; raw source notes stayed out of model output. The parser now exports
  credential-free plans, and `reconcile-plan.mjs` supports no-write,
  client-scoped comparisons with missing-place, staff, identity and conflict
  holds. This does not complete the automatic update writer.
- **Owner's NCC column decision:** `DATA` column J supplies Issue. Column U
  also has header `Issue`; although described as unused, the inspected snapshot
  contains 1,606 populated U cells. The explicit source-column alias preserves
  those values separately as source-only metadata, under narrative opt-in,
  without changing the active issue mapping or the original workbook.
- **Missing parks, owner-authorized 2026-10-20:** created Branford Park,
  Neale Park, Peppertree Park and Queens Garden as NCC location houses with
  canonical registry links and patrol zone facets. Registry-wide duplicate
  checks found no matches beforehand. Used `manage_crm_location` and
  `manage_crm_zone`; the bounded seed is
  `scripts/seed-rm-ncc-missing-places.mjs`. Rollback passed, apply succeeded,
  and replay created zero additional houses/zones. Source workbook SHA-256
  and exact source rows are preserved in location notes and audit metadata.
  All four remain unplaced, with unverified boundaries. No site facets,
  coordinates, legal restrictions, subscriptions or agreement coverage were
  inferred. Exact source labels are now in the checked-in NCC zone map;
  coverage must still pass the existing import guard before new activity is
  attached to these zones.
- Ambiguous labels such as `Culling Signage`, `NCC Toilets`, blank locations
  and `N/A` were not converted into invented places. Other unresolved places
  and all remaining workbooks still need source-specific checks.

- Owner direction: defer unattended SharePoint authentication and use the
  owner's synced Windows files while the laptop is running. Scan again when
  the laptop worker restarts so changes made during downtime are detected.
  The requested policy is add/update with preserved history, review conflicts,
  and never automatically delete FCM records.
- Added `services/document-source-worker/source-sync.mjs`: an allowlist of all
  22 requested patrol workbooks and recursive image discovery under `Photos`.
  The mounted root must be `C:\Users\squir\R & M Security and Investigations\RemSec - Documents`,
  not the patrol subfolder. Source files remain read-only; the checkpoint is
  stored separately. Files must be downloaded by OneDrive ("Always keep on
  this device") and finished saving before a version becomes eligible.
- The opt-in Compose profile `rm-source-sync` adds the isolated
  `fcm-rm-source-sync` service. It scans at startup and waits 60 seconds between
  completed scans, persists hashes/pending versions in `fcm_rm_source_sync`,
  and uses `restart: unless-stopped`. Docker Desktop must itself start after
  Windows sign-in; merely powering on the laptop does not prove Docker or
  OneDrive is running. A manually stopped container remains stopped.
- **Boundary:** this service is a local change queue, not an operational
  importer. It has no network access or credentials, and reports
  `promotion: not_connected`. A pending version can be acknowledged only with
  an applied receipt matching both the relative source path and SHA-256.
  Missing files preserve the previous version but cannot submit stale data.
  No deletion, photo matching, client/place inference, or business write occurs.
- **Remaining:** implement the audited versioned reconciliation handler, then
  install and live-prove the full path on the laptop. The current
  `stage_patrol_import_chunk` rejects changed immutable provenance; rerunning
  `scripts/import-patrol-log.mjs` on each save is not an update mechanism.
  CCL installation/maintenance and Mainland Pest Control need verified mappings.
  Neither is silently routed into another client's patrol records. Spreadsheet
  row identity and sheet mappings must be verified before any promotion.
- **Live access verified, 2026-10-19:** `CODESPACE_KVM` is the usable VPS SSH
  infrastructure credential; `VPS_SSH_PRIVATE_KEY` is not a recognized key in
  this session. Through the VPS and the existing audited Bob laptop API,
  KATANA's PowerShell is reachable, Ollama responds, all 22 requested workbooks
  exist, and `Photos` plus `Mainland Pest Control` exist directly beneath the
  synced `RemSec - Documents` root. Docker's inference and vision containers
  report healthy, and the document-source worker is running. Direct Codespace
  Tailscale timeouts do not establish that the laptop or its services are down.
  No credentials need changing on the strength of those timeouts. The new
  source-change queue has not been installed or connected to record promotion.
- Focused verification: `node --test test/laptop-source-sync.test.js
  test/document-source-ingestion-contract.test.js` passes 16 tests covering
  restart persistence, receipt identity/version checks, offline edits, missing
  sources, photo discovery, corrupt checkpoints, and source containment.

## APPROVED VEHICLE HISTORY AND IDENTITY RECORDS (2026-10-11)

- Recorded the owner ruling that plate mentions in the already-reviewed R&M
  patrol and CCTV working files are approved observations for this initial
  import. They do not require a second approval gate, but they retain the
  client/place owner, full note, source file/hash/sheet/row, timestamp,
  promotion actor, and audit receipt.
- Promoted all remaining approved plate mentions: 2,639 new structured
  observations, 2,822 canonical source links, 956 distinct plates, 2,008
  CCTV-derived observations, and 2,639 audit receipts. Existing exact
  observations were linked instead of duplicated. Verification found zero
  approved note mentions left unprocessed.
- Rebuilt the Identity Records vehicle path so R&M administrators can see
  client-owned vehicles through accepted operational relationships without
  changing record ownership. Vehicle cards now expose observation/evidence
  totals and first/last seen dates; record detail exposes approved notes,
  place/time/source provenance, activity history, and signed private photos.
- Matched 2,136 corpus photos to structured observations using the plate plus
  source-local filename date/time within a strict 15-minute tolerance. The 42
  ambiguous matches remain held; 19,518 filename-structured photos without a
  qualifying observation remain unmatched rather than guessed.
- Identical bytes are now reused as one organization evidence item and linked
  independently to each observation. The 2,136 source matches reduce to 2,116
  unique observation/hash pairs. A complete replay uploaded zero objects,
  reused all 2,136 matches, found every supporting link already present,
  created no audit receipts, and left zero duplicate support keys.
- Migration `20261010214725` and its rollback behavior test prove hash reuse,
  two-observation linkage, activity retrieval, audit, and replay safety. The
  Reports evidence panel also follows supporting-evidence links, so reused
  photos remain visible outside Identity Records.

## REPORTING WORKSPACE AND FORESTRY PHOTO WAVE 1 (2026-10-11)

- Reworked Reports around the operational decision flow: selected agreement and
  date scope, source-record/evidence totals, searchable patrol and observation
  detail, repeat-subject disclosure, then report drafting, human review, PDF,
  and delivery. Removed the duplicate recent-breach and observation tables.
- Record detail now exposes author/source provenance and existing private
  evidence, routes only genuine canonical UUIDs to vehicle/person workspaces,
  labels a plate-only fallback as a search, and generates an audited private
  single-record PDF instead of injecting record values into a browser print
  window. The PDF can include up to four linked JPG/PNG evidence photos.
- Repaired the Overview welfare reads. `welfare_alerts` has no `zone_id`, so
  welfare totals and queue rows are now honestly organization-wide; the UI says
  so. Agreement-linked field queues remain place-scoped, and client-owned
  activity was not moved into R&M ownership to make counts appear.
- Added migration `20261010201209` so governed external photo promotion
  preserves a known source capture timestamp in both `captured_at` and metadata.
  Existing browser uploads retain the current-time default. The live schema
  snapshot and Atlas were refreshed after application.
- Promoted a bounded first wave of 50 high-confidence OneFortyOne / Tasman Pine
  Forests photos: explicit plate, same date, matching place token, current
  `Photos/` tree, and timestamp within 15 minutes (including the accepted
  one-hour DST comparison where applicable). All 50 files were locally hashed,
  uploaded to deterministic private tenant paths, linked to 50 distinct
  observations, and recorded with source alias, original filename, match
  rationale, capture time, and audit receipt.
- Verified the evidence wave end to end: 50 evidence rows, 50 supporting links,
  50 audit receipts, exact source timestamps, and an evidence-backed live PDF.
  A full replay uploaded zero objects and reused all 50 paths and records.
  The remaining high-confidence candidates stay held for a later human-tested
  wave rather than being bulk-promoted automatically.
- Chromium checks at 1440 x 1000 and 412 x 915 confirmed the source-record
  workflow precedes report production, the empty state gives a safe next action,
  primary mobile controls remain visible, neither viewport has page-level
  horizontal overflow, and Overview emits no welfare/zone request failure.

## NZTA HISTORICAL PROVENANCE AND PERSON RECORDS (2026-10-10)

- Confirmed the R&M corpus contains a strong NZTA source pack under
  `RemSec - Documents/NZTA` and supporting staff records under `RemSec -
  Documents/Staff Details`.
- This material is valid as historical provenance for person/vehicle canonical
  records, including registration, training, compliance, and staff credential
  evidence, but it is not a current access entitlement or live authority check.
- Owner ruling: a person or vehicle record may be assembled or enriched from NZTA
  MVR provenance only when the source is documented and human-reviewed. The
  `nzta_mvr_sourced` flag remains historical provenance only and must not be used
  to infer legal authority, current permission, or live operating status.
- This aligns with the FCM identity model and the requirement to keep NZTA as
  source evidence rather than current power. It is a safe, governed way to
  promote a real R&M person record set without fabricating authority or silently
  importing unverified current access terms.
- Implemented the governed NZTA MVR workflow in migration `20261010204538`.
  Bob/local OCR now proposes source-time registered-person and vehicle facts,
  but only an organization administrator can approve them after comparing the
  private source image and explicitly confirming the person-vehicle match.
- A completed approval now updates the audited canonical person and vehicle,
  records the check in `vehicle_identity_checks`, links the tenant person,
  canonical person, canonical vehicle, identity document, and evidence item,
  and exposes the same private source through short-lived signed access from
  both record contexts. The source-time disclaimer remains visible.
- Live rollback verification passed the fail-closed confirmation check,
  evidence linkage, canonical updates, verified-person state, and administrator
  retrieval. The verification also exposed and repaired two shared database
  defects: the missing JSON object-length helper (`20261010205741`) and the
  canonical vehicle compliance-source constraint (`20261010205847`).
- Live schema truth and Atlas were refreshed after all three migrations.
  Focused OCR/migration tests passed 10/10, UI governance guards passed 4/4,
  the web production build passed, and all 564 migration versions are unique.

## HUMAN-AUTHORED SUBJECT AND EVIDENCE INTEGRATION (2026-10-11)

- Recorded the owner ruling that a human-authored report is sufficient
  provenance for the reported observation itself. A person/vehicle mention,
  suspicious activity record, or issued notice does not require a second human
  to verify that the report was made. This does not prove an allegation, infer
  an unstated identity, merge ambiguous people, or create enforcement authority.
- Proved the existing NCC patrol import is replay-safe against its real active
  workbook: 95 valid plate observations matched live records and zero new rows
  were proposed for the correct NCC client organization.
- Attached five exact source-matched NCC photos to three observations. The live
  result is five private, hash-addressed, non-court-ready evidence items, five
  observation-evidence links, and five audit receipts. Replaying an attachment
  left all counts unchanged.
- Repaired two production evidence-contract defects: external historical photos
  no longer fail the inference-watermark trigger, and `external_photo` is now an
  allowed supporting-evidence kind. External records remain non-court-ready.
- Removed the vehicle-only schema fiction from the observation spine:
  human-authored person/place/other observations no longer need fabricated
  plates or fabricated FCM officer identities. Source author, file, governed
  local reference, SHA-256, locator, subject kind, and deterministic import key
  are preserved.
- Added the governed, audited, replay-safe
  `import_human_authored_trespass_notice` path. It creates a tenant-scoped
  person record in manual identity review, its canonical projection, a genuine
  person observation, the linked notice, and one audit receipt atomically.
- Promoted the first high-confidence notice wave from the restricted corpus:
  11 notices, 11 person observations, 11 canonical-person projections, and 11
  audit receipts. OneFortyOne owns eight records (three explicitly issued,
  five lifecycle drafts); Tasman Pine Forests owns three drafts. Templates,
  unserved copies, ambiguous shared scans, and client-unresolved records were
  held rather than guessed.
- CRM account overview now reports live observation and evidence counts.
  Client/report/list surfaces render person and other non-vehicle observations
  without assuming a plate or linked user account.
- Regenerated `supabase/schema.sql` from the live catalog and refreshed Atlas
  after applying migrations `20261010191817`, `20261010192005`,
  `20261010192110`, `20261010192429`, and `20261010192744`.

## ACTIVE-LOG RECONCILIATION (2026-10-09)

- Read-only reconciliation confirmed the active client organizations already
  exist under their canonical names; no organizations were created from workbook
  abbreviations. `MPC` is activity on Tasman Pine Forests Limited and uses the
  existing `MPCPEST` import namespace, not a new client organization.
- The authenticated, linked Supabase CLI was used for the existing importer
  transaction path (`scripts/import-patrol-log.mjs --use-supabase-cli`). The
  importer still defaults to rollback/dry-run; each promoted group was followed
  by an identical dry-run with zero new inserts. No narratives, km/cost fields,
  or finance records were imported.
- **258 incremental patrol records applied** from the active workbooks: 38
  observations and 220 location events. Breakdown: M&R 3 observations + 4
  events; MPC/TPFL 7 events; NCC 1 event; OFO 2026 3 events; Stringer 6
  observations; STAND 4 observations + 18 events; TDC 16 events; TPFL 2026 24
  observations + 171 events; DOC 1 observation. Every new row has the source
  workbook name, sheet, original row number, and SHA-256 in its import metadata.
- Blank-date, duplicate, and unresolved-place rows were not forced into records.
  Existing rows with implausible future dates were not modified: two M&R events
  date to 2028, and one OFO plus one STAND event date to 2926. The current
  importer rejects those future dates; correcting historic stored rows requires
  source-level review.
- **DOC duplicate-key exception:** the current full-sheet preview proposed 16
  observations, but the live org already has 16 DOC observations. A read-only
  plate/time/place comparison identified 8 exact local-time matches and 3
  same-day/place matches. Only the single unmatched, place-resolved worksheet
  row 105 was imported; its replay inserts zero. Other ambiguous/unplaced rows
  remain held.
- **CommunityCameras/CCL is not a patrol-client import.** Its 2026 sheet has 111
  dated rows, but its `NELS`/`TASM` codes do not resolve the recorded locations
  to existing canonical places (only 1 of 17 dated code/location pairs matched
  after removing a trailing organization suffix). Existing NCC/TDC agreements
  declare patrol/access-control, not Workshop; R&M's Finance subscription is
  suspended. No CCL work orders, new sites/zones, or new organization were
  created. Per owner ruling below, CCTV evidence and physical installation/
  maintenance remain separate; location is the only required common link.

## Done (live, committed, tested)

- `person_permits` + `person_permit_vehicles`: org-scoped forest/site access
  permits linked to canonical person + vehicle records, three-tier RLS security
  (locked base table protects `firearm_licence_number`, redacted
  `person_permits_fieldwork` view for general use).
- 141 real forest-access permits imported from OFO's live RAMS export (92
  vehicle links, 125 canonical people), surfaced in `OfficerVehicleLookupPage`
  and `VehicleSearchPage`.
- **OFO permit workbook enrichment** (2026-10-27, migration
  `20261101110000`; live, applied by hand with its ledger row because the
  release lane's database token is rejected). The OFO
  "Permit Extract" workbook has 112 permits, all with start and finish dates;
  85 list 92 vehicles. `scripts/enrich-ofo-permits.mjs` sends each permit
  through the audited, fill-only `import_person_permit` RPC: blanks are
  filled, recorded values are kept, holders are never changed, and a holder
  whose email belongs to a differently named person is held for review. One
  vehicle cell written as free text could not be parsed into plates and is
  left for manual entry. "Keys issued" is recorded as yes/no. Firearm licence
  numbers go only to the locked base table. Permits that exist only in the
  earlier RAMS CSV have no dates, so they show "Dates not recorded". The TPFL
  workbook is a forest-area catalogue and the employee sheet is not imported.
  Person search now finds permit holders, including by exact permit number,
  and shows their permits; the Person, Vehicle and Officer lookup pages share
  one permit card. A permit holder is never shown as a vehicle's owner.
  Committed: 99 permits enriched, 2 vehicles newly linked and 74 already
  linked. Validity across R&M's 143 permits: 92 expired, 7 expiring within 30
  days, 44 with no recorded dates. 13 permits not yet on file were held
  because their holders were recorded by surname alone. A replay changes
  nothing.
- **Permit holder identity repair** (2026-10-27, migration
  `20261101120000`). The RAMS booking import recorded 125 permit holders by
  surname alone and merged different people who share a surname. The OFO
  extract names the holder of each permit, so
  `scripts/enrich-ofo-permits.mjs --repair-holders` groups each record's
  permits by that full name and calls the audited, admin-only
  `attribute_permit_holder` RPC. When every permit on a record is accounted for,
  the given names are added in front of the recorded surname. Otherwise each
  named holder moves to a person of their own. A name must end with the
  recorded name, and a person another organisation records is never renamed.
  The extract's 13 permits not yet on file then come in through
  `import_person_permit`. It now links a holder recorded by surname when the
  email agrees and only one such holder exists, then completes that name, or
  creates the named holder. Every step carries its planned outcome, and the
  database rolls back and holds any step that departs from it. Planned against
  the live snapshot: 81 names completed, 14 holders separated, 13 permits
  linked. Left for review: 30 surname-only holders with no permit in the
  extract, and 3 whose extract name does not extend the recorded one. Truth
  table: `test/permit-holder-identity-repair-migration.test.js`.
- Dispatch-job vehicle travel cost bridged into `finance_service_costs` (was
  previously fully disconnected from the P&L pipeline) + a "compare contract
  price to actual cost" action in `FinanceControlPanel`.
- Observation search (`search_observations` / `ObservationSearchPage`) verified
  correct end-to-end (guard tests + live join reproduction) — R&M's org simply
  had zero observations before this effort began; not a bug.
- **Wave 1 real clients seeded** (2026-09-23, commit `1229d396`, pushed to
  `main` at `33ec4f16`): NCC (Nelson City Council), TDC (Tasman District
  Council), **STAND** (renamed live from "PF Olsen Ltd" per the PF Olsen /
  Forest360 merger — former name retained, see below), Merril and Ring
  Forestland Management, Private - Stringer, Fulton Hogan, Taylors
  Contracting, Birdhurst, Thomas Bros. All real, all built from R&M's own
  patrol-log spreadsheets, all zone coordinates geocoded live via the
  `linz-lookup` edge function (not invented). DOC and OFO/TPFL were already
  seeded before this tracker existed.
- **Wave 2 real clients seeded** (2026-09-23): Operation Lizard (DART) — a
  pest-control camera/trap network whose site coordinates were given as exact
  NZTM2000 grid references, converted to WGS84 with a proper Snyder inverse
  Transverse Mercator implementation rather than approximate text geocoding;
  R&M Other Private Clients (one umbrella org for several small unrelated
  private residential contacts — Gary Adams, Sonja and Dave/"Big Bush", Bella
  Vista Motel — sharing one R&M billing file); Private - Parks; Private -
  Redvale - Merc. Confirmed via file inspection that Cycle Trails, Digger
  work, and OFO Culling (REMSEC project logs) are activity tied to the
  already-seeded TPFL/OFO orgs, not new clients — correctly not seeded as
  separate organizations. CommunityCameras/CCL confirmed install/maintenance
  only, not a patrol client — out of scope.
- **Former-organization-name retention**: a rebrand/merger (STAND / PF Olsen)
  no longer silently loses the old name. Reused the existing, previously-empty
  `import_org_aliases` table (`alias_kind='former_name'`) and surfaced it in
  `CRMPage.tsx`'s account register ("formerly PF Olsen Ltd"). This is now the
  established pattern for any future org rename/merger/acquisition — add one
  alias row, no schema change needed.
- `seed-forestry-sector-rm.mjs` extended to accept `--file <path>` so the same
  idempotent org/site/zone/agreement seeding logic is reusable for new data
  files without duplicating the SQL.
- **Wave 3 real clients seeded**: Department of Conservation (DOC) — this
  corrects an earlier, wrong claim that DOC was already seeded; a direct
  live-database check found it did not exist. 8 real zones geocoded from the
  full 164-row raw log (not just the 3 visible in the pivot summary): Hackett
  Carpark, Mt Robert Carparks, Graham Valley Rd, Flora Carpark, Wairoa Gorge,
  Tennyson Inlet, Paton Rd, St Arnaud.
- **8 real R&M officer accounts created** (owner instruction: "you can add the
  users, I'll resend the invitation later, Rob is a master user the rest are
  officers"): Rob Crawford (master, real email found in an NCC intel note),
  Colin Eathorne, Susan Finigan, Evan Garland, Marty Lucas, Wade
  Sutherland-Berkett, Pete Crawford, Reuben Stanfield (all officer). These are
  R&M's actual historical patrolling staff, who previously had zero system
  accounts — only the owner (Don Squires) had one.
- **Phase 2 patrol-log importer built and proven end-to-end**
  (`scripts/import-patrol-log.mjs`): parses a client's raw patrol-log CSV
  (exported from the source spreadsheet), resolves vehicle plates (with
  proper multi-plate-cell splitting and shape validation — a real
  concatenation bug was found and fixed during testing), resolves the
  Patroller column against the 8 real officer accounts, and writes to the
  correct table: vehicle-plate sightings with a resolvable officer go to
  `observations` (verified live via `search_observations`); everything else
  (camera-only activations, unattributed entries) goes to `location_events`
  via the governed `create_location_event()` RPC. Idempotent via
  `external_ref`. Run against DOC's full real history: 16 observations + 86
  location_events, all verified live, zero duplicates, zero data-quality
  issues after the fix.
- **`location_events` wired into the UI** for the first time — it existed in
  the schema with zero frontend references before this session. Added a
  "Recent activity" section to `ZoneDetailPage.tsx` and an "Activity" tab to
  `SiteDetailPage.tsx`, both querying `location_events` directly.
- **Phase 2 importer generalized and run against NCC** (2026-09-23, second
  real client after DOC — proves the importer isn't a DOC-only one-off):
  - Generalized `import-patrol-log.mjs`'s column resolution to try several
    candidate header names per logical column (`pick(...)` helper), since
    NCC's raw sheet uses different headers than DOC's (`"24hr Time"` not
    `Time`, `Description/Comments` not `Comments`, `Job Time NCC`/`Job Km NCC`
    not `Job Time`/`Job KMs`) — confirmed real, expected per-client variation,
    not a one-off quirk.
  - Added a stable `Reserve` code column as the PRIMARY zone-resolution key
    (tried before the free-text `Location` column) for sheets that have one —
    NCC's `Location` text is often sub-detail/comment-like and not a reliable
    join key on its own (e.g. many `MAIT`-reserve rows have `Location` values
    like "Neds Creek" or "Atmore Terrace", real sub-places within the same
    Maitai Valley Rd patrol zone).
  - Added multi-officer-cell handling: some rows record two officers on a
    joint patrol in one cell separated by a newline (e.g. "Colin
    Eathorne\nWade Sutherland-Berkett") — now resolves the first name that
    matches a known officer instead of requiring the whole raw cell to match
    exactly.
  - **7 more real officer names found and added**: Sally Curtis, Colin
    Nelson, Ash Bremner, Dan Douglas, Dave Porter, A Goodall, Glenn Gribben
    (15 real R&M officers now on file total).
  - **7 new NCC zones geocoded and added** beyond wave 1's original 4
    (Tantragee Saddle/Tantragee Rd, The Grampians, Wakapuaka Cemetery,
    Kinzett Terrace, Pioneer Park, Bishopdale Reserve, Montgomery Carpark) —
    wave 1 only captured 4 of 22 real Reserve codes found in the full
    3,100-row raw log; these 7 additions cover the next-highest-volume real
    places. Two more candidates (Smiths Reserve, Busch Reserve) were
    deliberately left unplaced — no confident Nelson-area geocode found, and
    Busch Reserve's only geocode candidate resolved to a different district
    (Tasman, not Nelson City) despite several query variations; not guessed.
  - **Result**: 96 observations + 1373 location_events imported (738 of 3099
    raw rows skipped — no parseable date, a genuine gap in 5+ years of manual
    spreadsheet upkeep, not an importer bug; 888 skipped — no resolvable
    zone, mostly non-place administrative categories like "Culling Signage"
    sign-installation logistics and "All Facilities"/"NCC Toilets" catch-alls
    that were deliberately never mapped). Verified live: 0 garbage plates, 0
    duplicate external_refs, and `search_observations` correctly surfaces the
    real data (confirmed only after setting the actor's
    `request.jwt.claim.sub` — the function is SECURITY INVOKER and returns
    empty with no auth context, which is correct RLS behavior, not a bug).
- **Phase 2 importer run against TDC** (2026-09-23, third client — proves the
  importer generalizes across genuinely different raw-sheet conventions
  without per-client script forks):
  - TDC's zone-code column is named `CODE`, not `Reserve` — added as another
    candidate to the `pick(...)` header resolver (`reserve: pick('Reserve',
    'CODE')`), and `Job kms` (lowercase, no suffix) as another `jobKms`
    candidate.
  - **Added request batching**: TDC's 6,366-row log (roughly double NCC's)
    produced a combined JSON payload the Management API rejected outright
    with "request entity too large" in a single request. Refactored the
    apply/dry-run step to chunk both the observations and events batches
    into fixed-size slices (300 each) and run one transaction per chunk,
    summing the reported counts — this is a genuine scale limit any client
    with a large multi-year log will hit, not a TDC-specific quirk; keep
    this batching for every future client run.
  - Cross-referenced TDC's own List (Name→Code) reference sheet before
    geocoding, rather than guessing at 4-letter codes — found that `TAKA` is
    used as the code for TWO physically distinct real places (Haldane Rd and
    Rototai Reserve, both in the Takaka/Golden Bay area, confirmed distinct
    via different comment content). The zone-map deliberately does NOT use
    `TAKA` as a lookup key (ambiguous); both places are mapped via their
    Location free-text instead.
  - **14 real zones added** beyond wave 1's original 2 (Rabbit Island,
    Appleby Recreation Reserve): Busch Reserve (Aniseed Valley Rd — confirmed
    via this List sheet to be TDC's, not Nelson City Council's, despite
    appearing unresolved in NCC's own log too), Saxton Field, Baigent
    Reserve, Estuary Lane, Haldane Rd, Rototai Reserve, Lee Valley Reserve,
    Tadmor Valley Rd, Washbourn Gardens, Motueka River, Hoddys Reserve,
    Spooners Lookout (Belgrove area — approximate, low geocode confidence),
    Bartletts Rd, Richmond Recycle Centre.
  - **6 more real officer names found**: Steve Henery, Andrew Curtis, Jacob
    Lucas, Deb Crawford, Ken Eccles (created new profiles), and Don Squires
    (the owner — already had an R&M-org `user_profiles` row from earlier in
    this project, reused rather than duplicated). 20 real R&M officers now
    on file total.
  - **Result**: 364 observations + 4523 location_events imported (611 of
    6365 raw rows skipped — no parseable date; 817 skipped — no resolvable
    zone). Verified live: 0 garbage plates, 0 duplicate external_refs,
    `search_observations` confirmed surfacing real TDC data.
  - Confirmed (read-only, not yet acted on) that TDC ALSO has an unrelated
    duplicate "Tasman District Council" org in this project
    (`parent_organization_id IS NULL`) — same class of pre-existing
    demo/test-fixture name collision as NCC's, not caused by this session.
    See the dedicated finding below; the same "check parent_organization_id
    before trusting a name match" rule applies to every future client.
- **Phase 2 importer run against M&R Forestland Management** (2026-09-23,
  4th client — small forestry client, ~1,171-row log, sheet named "NOW" not
  "DATA"/"2025"):
  - M&R's own List sheet is only a GL billing-code reference, NOT a forest
    name/code lookup like NCC/TDC's — it documents just 2 of 20 real forest
    codes actually used in the raw log (Kaimua/KAIU, Waihopai/WAIH). The
    other 18 had to be identified by sampling Location/Comments text per
    code rather than trusting the List sheet blindly.
  - **6 more real forest blocks found**: Birdlip Rd (covers both ONAM and
    BIRD codes — confirmed via matching comment content to be the same
    physical place), Kytes Creek Rd (WAIK/KYTE/KYTES), Musgrove Rd / Ben
    Redwood Forest (BENR/AVON), Pukaka Valley Rd (PUKA), Chestnut Rd (CHES),
    Branch Forest / River Rd (BRAN). These are remote private forestry
    access roads in the Marlborough back country — geocoding returned only
    generic/wrong fallback matches for 4 of 6 (a repeated identical
    catch-all address, or an unrelated roading-contractor's office) and
    those 4 are created **unplaced** (named block only, no coordinates —
    the same supported pattern already used for STAND's Borlace Forest).
    Chestnut Rd and Branch Forest share one confident nearby locality match
    (the raw log's own comment explicitly says Branch Forest is "same as
    chestnut rd") and are placed there approximately with a large radius.
  - 1 more real officer name found: Beau Webster.
  - **Result**: 103 observations + 776 location_events imported. Verified
    live: 0 garbage plates, 0 duplicate external_refs.
- **Phase 2 importer run against Taylors Contracting** (2026-09-23, 5th
  client — small orchard/quarry security client, real street addresses, no
  Reserve/CODE column at all):
  - Wave 1 only seeded 4 of Taylors' 6 real addresses from its own Details
    sheet — Arthur's (53 Tahi Street, Mapua) and Mum's (16 Lansdowne Rd,
    Appleby) homes were missed. Added as new residential zones, matching
    the existing Charlie/Matt pattern. Mum's address needed a
    Nelson-region-qualified geocode query — the bare address alone matched
    an unrelated same-named street in Auckland.
  - **`pick()` made case-insensitive**: Taylors' header has "Log  no" (double
    space, lowercase) where every other client used "Job"/"Log No" — rather
    than adding an endless list of case-variant candidates for every future
    client, the header matcher now compares case-insensitively. This is a
    durable fix, not a one-off patch.
  - **Real, valuable capability added: site_id support.** Every prior client
    (DOC/NCC/TDC/M&R) only ever needed `location_zones` — Taylors is the
    first to prove the importer against a client with BOTH `client_sites`
    (Taylors Quarry, Taylors Yard — commercial properties) and
    `location_zones` (family residences) in the same file. `zoneMap` entries
    can now be either a bare zone UUID string (unchanged, all prior
    zone-maps still work) or `{ "site_id": "<uuid>" }`, and both
    `observations` and `location_events` (`create_location_event`'s
    `p_client_site_id` parameter) support attaching to either place type
    with no schema changes needed — this was already a first-class
    supported pattern in the schema, just never previously exercised by
    this importer. Verified live: of 48 imported location_events, 28
    correctly attached to a client_site and 20 to a zone.
  - **Result**: 1 observation + 47 location_events imported (only ~48 of 421
    raw rows have real data — most of the sheet is template/GL-reference
    rows with no date, correctly skipped). Verified live: 0 garbage plates,
    0 duplicate external_refs.

## Known gaps / real bugs found this effort (fix before relying on them again)

- **The seed script does not "upgrade" an existing org.** When it matches an
  existing organization by name (or `client_request_id`), it correctly adds
  new child rows (sites/zones/agreements/modules) but never updates the org's
  own `status`/`active`/`contact_*`/`account_notes` columns. STAND's
  prospect→active upgrade was silently missed and had to be fixed by hand.
  Any future "upgrade this CRM prospect to an active client" step MUST include
  an explicit manual `UPDATE organizations SET status=..., active=...` — do
  not trust the seed script for that part.
- **Seed JSON enum values must be verified against schema.sql, not
  remembered.** `location_zones.rule_type` only allows `overnight_limited`,
  `day_visit_only`, `prohibited`, `restricted`, `unrestricted` (not
  "monitored"); `location_zones.zone_type` only allows `freedom_camping`,
  `parking`, `noise_control`, `biosecurity`, `trespass`, `access_control`,
  `general`, `patrol_route` (not "patrol"); `client_sites.site_type` only
  allows `freedom_camping_area`, `parking_area`, `commercial_premises`,
  `residential_complex`, `government_facility`, `hospital`,
  `education_facility`, `industrial_site`, `public_space`, `other` (not
  "residential" — use `other` for a single private home). Grep
  `<table>_<column>_check` in `supabase/schema.sql` before writing new zones.
- Mainland Pest Control's patrol log is **not** a separate client: its
  `Company` column shows `TPFL` for sampled rows, meaning the work happens on
  Tasman Pine Forests' already-seeded land. Not yet cross-checked in detail
  against TPFL's 26 existing zones to confirm full name/code overlap.
- Port Blakely has **zero** real patrol-log data in R&M's files (confirmed via
  exact folder listing) — remains a CRM-only prospect; do not manufacture
  sites/zones for it.
- **Real cross-cutting finding (whole-build shakedown), RESOLVED 2026-09-23:
  `organizations.name` has no uniqueness constraint, and a prior pass modeled
  draft/never-invited provider prospecting relationships by creating a
  SEPARATE organization row per provider instead of one canonical council org
  with multiple `service_agreements`.** Discovered while starting the Phase 2
  NCC import: THREE separate organization rows were all named exactly
  "Nelson City Council" —
  - `405fc1f7-45e8-4736-a517-885bb3e5ef95` — the REAL one, R&M's wave-1 seed
    (`organization_type='government'`). **Canonical — use this id for all NCC
    work.**
  - `fc4ca1c9-e606-4a93-b21b-da79274c7440` — a draft, never-invited
    "First Security Guard Services LTD" prospecting shell (59 residential
    addresses tied to a draft "site services proposal", plus 1 real-named
    site/zone tied to a separate draft "Responsible Camping and Guarding"
    proposal from First Security's Nelson branch).
  - `7171d3c7-f820-483b-ba2d-122fe067b8a8` — a `status='prospect'` shell
    parented directly by First Security HQ (3 client_sites: Miller Acre,
    Nelson Public Library, Tahunanui Beach; no agreement linked).
  Initial read (2026-09-23 morning) mistook this for meaningless E2E test
  debris because a `finance-e2e-client@field-compliance.test` user profile
  (matching this repo's `*@field-compliance.test` fixture convention) was
  attached to the `fc4ca1c9` shell. Owner corrected this: it is real,
  First Security-branded prospecting data for the same real council — just
  modeled with the wrong shape (a second org row per provider relationship
  instead of one council org + multiple `service_agreements`, which the
  schema already supports via `provider_organization_id`/
  `client_organization_id`). Per the owner's own model: *a site/zone belongs
  to the client org as a chargeable "seat" regardless of which provider, if
  any, currently has an accepted agreement for it* — so the real fix is to
  move the child data onto the canonical org, not quarantine it.
  **Fix applied via `scripts/merge-legacy-org-shells-ncc-tdc.mjs`** (kept in
  the repo as the audit trail — do not delete): retargeted 63 `client_sites`,
  1 `location_zones`, and 4 `service_agreements` (client side only; provider
  side left untouched as genuine CRM history of an unaccepted pitch) from
  the two NCC shells onto `405fc1f7`, and the equivalent TDC shell
  (`6f59d817-a432-4401-b44e-896c32e2ea05`, 1 site + 1 draft agreement) onto
  `54ade19f-0bb7-45ca-a32d-2d87214c4e77`. Disambiguated the one literal name
  collision the merge created (two "Miller Acre" sites). Archived (renamed,
  `active=false`, `discoverable=false`, `status='archived'`, rationale
  recorded in `account_notes`) the 3 emptied shells rather than deleting
  them. Deactivated 2 genuinely-unrelated test-fixture `user_profiles`
  (`test@test.com`, `finance-e2e-client@field-compliance.test`) found
  attached to the shells.
  **Schema discovery worth knowing before any future org-merge**: `client_sites`
  and `location_zones` each "hang off" a `locations` row (an org-scoped
  "house", itself linked to a genuinely cross-org `canonical_places` row via
  `canonical_place_id`). Triggers `zz_client_sites_place_house` /
  `zz_location_zones_place_house` / `zz_locations_place_identity` REJECT an
  UPDATE that would leave a site/zone pointing at a house owned by a
  different organization ("Site/Zone ... cannot hang off a house owned by
  another organisation"). **You must re-home the underlying `locations` rows
  to the new owner FIRST, in the same transaction, before retargeting the
  sites/zones that reference them** — a naive `UPDATE client_sites SET
  client_organization_id = ...` alone will fail partway through. Confirmed
  before running that none of these houses were shared with any org outside
  the 3 legacy shells (each house was privately owned 1:1), so re-homing was
  safe; always re-verify this for any future merge rather than assuming.
  Confirmed the SAME pattern for TDC: a second, unrelated "Tasman District
  Council" org existed with `parent_organization_id IS NULL` — also merged in
  the same pass. Expect to find this again for other government/council-style
  client names as more clients are onboarded; the fix pattern above (re-home
  houses, retarget sites/zones/agreements client-side, disambiguate name
  collisions, archive-don't-delete the shell) is now the reusable playbook —
  don't re-derive it from scratch, adapt the script.

## Open items (not yet done)

1. **RESOLVED 2026-09-24 — Wrattens fully seeded as its own 17th client
   org.** The security prerequisite (investigation workspace hardening) was
   completed first; see "Wrattens full client seeding" below for the
   complete write-up. R&M's active roster is now fully populated — every
   real client has real patrol history.
2. **TDC has ~50 more reference-list entries** beyond the 16 now zoned
   (Rabbit Island, Appleby Recreation Reserve, Busch Reserve, Saxton Field,
   Baigent Reserve, Estuary Lane, Haldane Rd, Rototai Reserve, Lee Valley
   Reserve, Tadmor Valley Rd, Washbourn Gardens, Motueka River, Hoddys
   Reserve, Spooners Lookout, Bartletts Rd, Richmond Recycle Centre) — geocode
   more as real patrol activity against them is found, not preemptively.
3. **STAND's "Borlace Forest" zone — RESOLVED 2026-09-23.** Placed via
   `linz-lookup` during STAND's own Phase 2 run (Borlase Avenue, St Arnaud
   area) — see the STAND write-up below.
4. **RESOLVED 2026-09-23 — all active clients seeded.** Private-Parks (13th)
   and Private-Redvale-Merc (14th, final) both imported cleanly — see their
   write-ups below. Every client in R&M's active roster except the
   deliberately-deferred Wrattens (item 1) now has real patrol history in
   `observations`/`location_events`. Proven against DOC, NCC, TDC, M&R,
   Taylors, STAND, Birdhurst, Thomas Bros, Stringer, Fulton Hogan, DART, PVT,
   Private-Parks, AND Private-Redvale-Merc (fourteen clients). PVT additionally
   proved a genuinely cross-org scenario: a shared
   overflow log file can contain rows that really belong to a DIFFERENT
   already-seeded client, not the umbrella org itself — split the source CSV
   and run the importer once per target org/zone-map, using a distinct
   `--client-code` for the split-off subset so its `external_ref`s can never
   collide with that client's own primary import. Each client needs
   its own zone/site-name-to-id map built from its actual
   Location/Reserve/CODE/Forest/Site column values (same process used so
   far: export full raw sheet to CSV, count distinct location values,
   cross-check the client's own List/Details/reference sheet before
   geocoding — but verify it's actually a complete lookup and not just a
   GL-billing reference like M&R's turned out to be — geocode any new real
   places with a region qualifier if the bare address returns a wrong-region
   match, build the map, dry-run, apply). For any client with a large
   multi-year log (thousands of rows), the importer's batching (chunks of
   300) already handles the request-size limit — no further script change
   needed there. More officer names will likely surface — add them as real
   `user_profiles` the same way (role 'officer' unless told otherwise), and
   check whether a name already has a profile under R&M's org before
   creating a duplicate (Don Squires already did). Before seeding zones for
   any client, also run the duplicate-org check (`select id, name,
   organization_type, parent_organization_id from organizations where
   lower(name) = lower('<client>')`) — both NCC and TDC turned out to have
   unrelated pre-existing orgs sharing their exact name.
5. **Whole-build live-org shakedown** (the other half of this task): with
   real, populated org data now flowing all the way through to
   `search_observations` and `location_events`, walk through the remaining
   operational surfaces a real R&M admin/officer would use — CRM account
   view, dispatch, rostering, finance/invoicing, permit lookup — and fix
   anything that breaks or looks wrong against real data. Record findings
   here as they're found.
6. **RESOLVED 2026-09-26 - DART's "Update 251215" sheet imported.** Its
  header-less 539-row layout was normalized locally without changing the
  source workbook. The importer now collapses duplicate external references
  before chunking and can preserve source filename, SHA-256, sheet, and row
  provenance. Fifteen verified `Cat` location aliases were added to the
  existing DART Zone map. Result: 323 unique events imported, 162 duplicate
  source rows collapsed, and 54 blank/"All Sites" rows intentionally left
  unplaced. See the DART follow-up below.

## PHASE 2 RUN AGAINST STAND/PF Olsen (2026-09-23) — 6th client, date-serial fix

- STAND's List sheet is ONLY a GL billing-code reference (3 of 18 real Forest
  codes documented) — same gap already found for M&R. Sampled Location text
  per undocumented code from the full 4,024-row ACTIVE sheet to identify 8
  more real forest blocks.
- **Real bug found and fixed in the importer itself**: exporting the raw sheet
  via Excel COM's bulk `Value2` read (much faster than the previous
  cell-by-cell `.Text` approach — see below) returns dates as raw Excel serial
  numbers (e.g. `44988`) instead of a `dd/mm/yyyy` string. `parseNzDate()` in
  `scripts/import-patrol-log.mjs` now accepts both — a genuinely reusable fix
  since every future client export should use the faster method.
- **Excel COM export performance**: switched to `$range.Value2` (one bulk
  2D-array COM call) instead of looping `$range.Cells.Item(r,c).Text` per
  cell — the latter took minutes on a 4,025×32 sheet; `Value2` took seconds.
  Use this for all future client exports.
- Finally placed the long-outstanding **Borlace Forest** zone (unplaced since
  2026-09-22) via a real `linz-lookup` hit on "Borlase Avenue", St Arnaud area
  — done as a direct `UPDATE location_zones` (not the generic seed script,
  since the zone already existed under a different `external_ref` than a new
  seed file's key scheme would match).
- 4 new zones confidently geocoded (`scripts/data/rm-active-clients-wave8-stand-zones.json`):
  Sherry River, Linkwater (Queen Charlotte Drive, Marlborough — a different
  region from the rest of STAND's Tasman-cluster blocks), Glider Rd (near the
  Nelson Lakes Gliding Club, Howard — the raw Forest code is `RICH` but no
  "Richmond"-area location text was ever found, so the zone is named for the
  confirmed real place instead of the code's apparent abbreviation), Tee Total
  Road. 4 more created UNPLACED after multiple failed geocode attempts:
  Slippery River (187 rows — meaningful volume, still no confident match),
  Tunnicliffes Rd (covers both Forest codes `KAIN` and `TUNN`, which share the
  same raw Location text), Boulder Rd/Homestead Rd, Frorieps Rd.
  `ALLF` (143 rows, Forest/Location both blank) confirmed a non-place
  administrative code, same as NCC's `ALLF` — left unmapped.
- One officer-name variant found: "Deborah Crawford" in the raw log is the
  same real person as the already-known "Deb Crawford" — added as an alias in
  `KNOWN_OFFICERS` pointing at the same existing `user_profiles` id, not a new
  profile.
- Result: 398 observations + 2695 location_events, verified live (0 garbage
  plates, 0 duplicate external_refs, real recent+historical dates spanning
  2023–2026 confirming the serial-date fix works across the full range).

## PHASE 2 RUN AGAINST Birdhurst (2026-09-23) — 7th client, shared-code disambiguation

- Wave 1 seeded 1 site (Birdhurst Packhouse) + 4 zones from the Details
  sheet's 6 documented COMPANY rows — but missed "Golden Bay Fruit /
  Birdhurst Sheds" entirely, and missed a separate FAMILY section (Reese and
  Andrea's home, Sue Wilkins' home) under an explicit "NEW CONTRACT for
  residential security" note. Exporting the full 762-row 2025 sheet and
  counting real (dated) Site-code frequency also found 2 more real places
  never in the Details table at all: Central Rd (20 rows) and a covert camera
  at Staples St (6 rows).
- **Real pattern found: one billing code can be shared by several distinct
  real places, disambiguated only by free-text Location.** `MOT` covers
  Motueka Orchard, Birdhurst Packhouse, Martins Block, Central Rd, AND Staples
  St — five different real places, not one. The zone-map deliberately has NO
  `MOT` key; each place is matched via its own Location-text variants instead
  (13 of 79 `MOT` rows have no Location text at all and are correctly left
  unresolved rather than guessed which of the five they belong to).
- 3 new `client_sites` (Golden Bay Fruit, Reese and Andrea's home, Sue
  Wilkins' home) + 2 new `location_zones` (Central Rd, Staples St), all
  confidently geocoded via `linz-lookup` from exact addresses given in the
  Details sheet. Reese/Andrea and Sue Wilkins are real named individuals'
  home addresses — same PII class as PVT's private clients, no extra table
  security needed beyond the existing model (this is not the
  Wrattens-style active-dispute sensitivity).
- Result: 2 observations + 129 location_events, verified live (0 garbage
  plates, 0 duplicate refs, real events correctly attributed across all 5
  MOT-disambiguated places including the newly-created Central Rd zone).

## PHASE 2 RUN AGAINST Thomas Bros (2026-09-23) — 8th client, address-collision gotcha

- Wave 1 seeded 2 of 5 real COMPANY sites from the Details sheet (Talasea
  Packhouse, Dehra Doon Packhouse) — missed Accomodation (RIA), Shop (RIS),
  and Kelso (KEL). Confirmed via the full 1,173-row 2025 sheet that all 5
  documented codes are genuinely in use, no undocumented codes this time.
- **Real seed-script gotcha found**: giving RIA and RIS the identical address
  string ("opposite Talasea" gave no distinct street number) made the first
  dry-run silently create only 1 site instead of 2 — `address_match_key`
  matched the second site onto the first site's already-created house. Fixed
  by using two adjacent real addresses from the same LINZ candidate cluster
  (516/518 Main Road Riwaka) instead of reusing one string twice. Always
  check the dry-run's `sites`/`houses` counts against how many distinct real
  places you actually expect before applying.
- Kelso's own name search returned only a same-named locality 500km away in
  Otago — clearly the wrong region, so created UNPLACED rather than accept it.
- No new officers (Rob Crawford, Colin Nelson, Pete Crawford all already known).
- Result: 14 observations + 47 location_events, verified live (0 garbage, 0
  dupes, real events across all 5 sites including the newly-placed ones).

## PHASE 2 RUN AGAINST Private - Stringer (2026-09-23) — 9th client, single-site

- Simplest client so far: one real site (Moutere Hill), already fully seeded in
  wave 1 — pure Phase 2, no new geocoding needed. Raw log uses 3 different
  codes (MTRN, STRI, MOUT) for the exact same physical property (confirmed via
  identical Location-text overlap: "Moutere Hill", "Stringers Gate", "Stringer
  Rd" all appear under more than one code) — all mapped to the one existing
  zone. No new officers. Result: 22 observations + 225 location_events,
  verified live (0 garbage, 0 dupes).

## PHASE 2 RUN AGAINST Fulton Hogan (2026-09-23) — 10th client, completed 2022 project

- Simplest client of all: only 8 real dated rows out of 382 in the whole raw
  log, all using the same code (`MAIT`, already-seeded Maitai Dam zone).
  Confirmed the memory hypothesis that this was a one-off, now-completed 2022
  infrastructure-protection contract rather than an ongoing client — all 8
  events date to Oct–Nov 2022. Both officers (Colin Eathorne, Susan Finigan)
  already known. Header quirk: this sheet's zone-code column is literally
  named "Code" (not "Reserve"/"CODE"/"Forest"/"Site") — already covered by
  the importer's case-insensitive `pick()` matching against its `CODE`
  candidate, no importer change needed.
- Result: 0 observations + 8 location_events, verified live (0 duplicate refs).

## PHASE 2 RUN AGAINST DART/Operation Lizard (2026-09-23) — 11th client, largest single import

- Real sheet-layout quirk: unlike every other client, this workbook's `2025`
  and `2026` raw-log sheets have their real header row ~265 rows DOWN, below
  a leading charge-code reference table (every other client has the header
  on row 1 and the reference table, if any, embedded within the dated rows).
  Both sheets had to be trimmed to start from the real header before the
  importer could run — a one-off pre-processing step, not an importer change,
  since this exact layout hasn't recurred elsewhere.
- Real pattern: ~95% of rows use a blanket `DART` code (not a per-site code)
  with the actual camera/trap site number embedded in free-text Location
  ("Trig Rd (Site 1)", "Thomas Creek Rd (Site 6)", plus "NO.n" and typo'd
  "TrigRRd"/"TrugRRd" variants, and a third road name "Old Sow Rd" whose
  camera numbering (10–15) overlaps Trig Rd's own — treated as the same
  patrol area rather than a third zone). Generated the 53-entry zone-map
  programmatically from every distinct Location string found (classified by
  road-name prefix) rather than hand-transcribing it — far less error-prone
  for this many variants. "All Sites" (54 rows, a blanket "covered everything
  today" entry with no single correct zone) deliberately left unmapped.
- Ran the two year-sheets as two separate importer invocations
  (`--client-code DART2025` / `DART2026`) rather than one combined run, since
  "Log no" numbering restarts each year — using the same client-code for both
  would have silently collided their `external_ref`s and dropped the second
  year's rows as false duplicates.
- Result: 681 (2025) + 1105 (2026) = 1786 location_events, the largest single
  client import this session, verified live (0 duplicate refs, correctly
  split 1272/514 between the Trig Road and Thomas Creek zones).

### DART `Update 251215` follow-up (2026-09-26) - deferred sheet completed

- Converted the workbook locally through the approved Excel-to-Markdown path,
  then exported only the `Update 251215` worksheet to a temporary
  importer-compatible CSV. The source workbook was opened read-only and was
  not modified or uploaded.
- Reused the existing `DART2025` idempotency namespace because this update
  overlaps the 2025 period. Added the 15 exact `Cat` spelling variants present
  in this sheet to `dart-zone-map.json`; blank Start/Finish rows and blanket
  `All Sites` rows remain deliberately unmapped rather than being forced onto
  one Zone.
- Hardened `import-patrol-log.mjs` to collapse duplicate external references
  before its 300-row transaction chunks. This makes rollback previews exact
  even when repeated source rows cross chunk boundaries. Added optional
  source filename/hash/sheet/row provenance without storing an absolute local
  path.
- Reviewed preview: 539 source rows; 485 place-mappable rows; 162 duplicate
  source keys; 54 intentionally placeless rows; 323 unique new events; two
  already-known patroller labels; date range 2025-10-13 to 2025-12-05.
- Applied 323 events in two governed chunks. Live verification: 323 rows, 323
  distinct external references, all 323 with source filename, SHA-256, sheet,
  and source-row metadata; 174 events at the Trig Road Zone and 149 at the
  Thomas Creek Zone. An identical post-apply dry run inserted 0 and skipped
  all 323, proving replay safety.

## PHASE 2 RUN AGAINST PVT/R&M Other Private Clients (2026-09-23) — 12th client, cross-org split

- Wave 2 seeded the 4 documented CLIENT rows (Gary Adams, Sonja and Dave x2,
  Bella Vista Motel). This pass found 2 more real properties never in the
  Details table: Glenrae (Holland Rd/Glenrae Rd, Tapawera — farm gate/fencing
  installation) and Baton Valley - Lublow (vehicle/stock/poaching incidents,
  coded inconsistently as both `BATO` and `MOT`).
  Both geocoded confidently via `linz-lookup` and added as `client_sites`,
  matching the umbrella org's existing "per-contact site record" pattern.
- **Real cross-org finding, confirming a memory hypothesis from wave 2**: 7 of
  this file's `MOT`-coded rows are NOT PVT's own client at all — they are
  genuine early-stage Birdhurst camera-install setup history (contacting Flash
  Electrical, liaising with "Andrea Wilkins" — the same family already seeded
  as a Birdhurst site), predating Birdhurst's own dedicated log file. Split the
  raw CSV in two before importing: the 7 Birdhurst-relevant rows were imported
  under Birdhurst's own organization and zone-map (client-code
  `BIRDHURSTPVT`, a distinct code from Birdhurst's own `BIRDHURST` import so
  the two runs' `external_ref`s could never collide), and everything else
  under PVT's own organization and zone-map (client-code `PVT`). **Reusable
  pattern**: when a shared/overflow log plausibly contains another client's
  real activity (matching names, matching location text seen elsewhere),
  check for it — do not assume every row in "a client's own file" belongs to
  that client.
- Result: PVT — 12 observations + 33 location_events; Birdhurst (via the
  split) — 7 more location_events. Verified live for both (0 garbage plates,
  0 duplicate refs in either organization, confirmed no collision with
  Birdhurst's existing import).

## PHASE 2 RUN AGAINST Private-Parks (2026-09-23) — 13th client, single-code simple case

- Smallest client this session: 9 total DATA rows, all coded `88VA`, matching
  the Details sheet's already-seeded "Eighty Eight Valley" property/zone
  exactly — no new places, no new officers (Rob Crawford already known).
- Result: 3 observations + 5 location_events. Verified live (0 garbage
  plates, 0 duplicate refs, real plate `ZD3838` confirmed with correct 2022
  dates via authenticated read).

## PHASE 2 RUN AGAINST Private-Redvale-Merc (2026-09-23) — 14th client (FINAL), name-alias fix

- Raw log used two codes, `REDT` (73 rows) and `REDB` (14 rows) — both read
  "Redvale" in the Location column, matching the existing "Redvale Top /
  Bottom (Redwood Valley)" zone name exactly (top vs bottom sections of the
  same property, both already covered by one zone id) — no new places.
- **Real name-matching gap found and fixed**: this file spells the known
  officer "Wade Sutherland-Berkett" without the hyphen ("Wade Sutherland
  Berkett"). Added as a second alias key in `KNOWN_OFFICERS` pointing to the
  same existing profile UUID, same pattern as the earlier "Deborah Crawford"
  alias — otherwise these rows would have imported fine as location_events
  but without correct officer attribution.
- Result: 4 observations + 83 location_events. Verified live (0 garbage
  plates, 0 duplicate refs, real plates MLA451/MLL451/BWA214 confirmed with
  correct 2022 dates via authenticated read).
- **This completes the full active-client seeding objective.** Every R&M
  client except the deliberately-deferred Wrattens now has real patrol
  history imported. Next phase: shake down data/reports/finance/km surfaces
  against this now-fully-populated real data, with UI/UX intuitiveness (the
  user does as little as possible; the app and Bob do the work) as a
  standing design lens — see open item 5 above.

## PHASE 2 RUN AGAINST OFO/OneFortyOne (2026-09-23) — 15th client, largest single import, real km tracking proven

- **Correction to the earlier "all clients seeded" claim**: OFO and TPFL were
  both structurally seeded (org/sites/zones/agreement) in an earlier wave but
  had **zero** patrol history rows — "seeded" only ever meant the org
  scaffold, not the actual patrol log import. Found by checking live row
  counts directly rather than trusting the earlier session summary.
- OFO's real forest estate is far larger than its 7 originally-seeded zones:
  128 distinct active forest codes found across the real 2025+2026 logs
  (11,786 rows). Cross-referenced every code against OFO's own "List"
  reference sheet (Forest Name/Forest Code columns — a real, authoritative
  lookup table, not something to guess from map images) to get real names.
  Real forestry maps (`OFO/Maps/Golden Downs.jpg`, `Rai.jpg`) confirmed ~30
  of these codes are genuine sub-blocks of the already-seeded Golden Downs
  Forest / Rai Forest zones — `parent_zone_id` (reinstated earlier today) was
  set for exactly those, everything else seeded as an independent flat zone
  rather than guessing at unverified geography.
- 3 codes (MANU, KAIN, TEET) mapped directly onto OFO's existing Manuka
  Island/Kainui/Teetotal zones rather than creating duplicates. One code
  (WAIR) mapped onto the existing Northbank Wairau zone.
  One single-row code (`PFO` — literally STAND's old "PF Olsen" abbreviation)
  was investigated for cross-org contamination like the PVT/Birdhurst case,
  but the single row's content gave no evidence it belongs to STAND — left
  unresolved rather than force a low-confidence reroute.
- **Real bugs found and fixed while wiring this up**: the `Job KM` picker had
  a wrong assumed header (`'Job KM OFO'`) that doesn't match OFO's actual
  bare `Job KM` header — fixed. The `distance_km` migration created earlier
  today (2026-09-23) had never actually been applied (a context-switch during
  the session left it un-run) — applied now, confirmed live. The importer's
  new `distance_km` population used `\d`/`\.` regex escapes inside a JS
  template literal — JS silently drops backslashes before unrecognised escape
  sequences in string literals, so Postgres received the literal (broken)
  pattern `^d+(.d+)?$` — fixed by switching to bracket-expression syntax
  (`[0-9]`, `[.]`) which needs no backslashes at all. Verified the ODO
  (running trip odometer, resets at shift/day start) vs Job KM (spreadsheet
  pre-computed delta between consecutive ODO readings) relationship against
  real consecutive rows before trusting `job_kms` as the real distance value.
- Result: 703 observations + 8,703 location_events, verified live (0 garbage
  plates, 0 duplicate refs). **`distance_km` populated on 703 observations
  (1,664.2km total) and 8,700 location_events (114,080.8km total)** — the
  first real proof the km-tracking work from earlier today actually works
  end-to-end on live data, not just the schema existing.
- Not yet done: "Cycle Trails Patrol Log 2021" (belongs to TPFL), "MPC log"
  (belongs to TPFL — Mainland Pest Control's own pest-control activity
  stream), "Digger work 2023" and "OFO Culling Log 2023" (both belong to
  OFO). Mainland Pest Control now exists as its own
  `organization_type='contractor'` org with a service_agreement to R&M
  (`1ccdd3fb-0b0a-478d-8441-6f14a85172aa`), per owner clarification it's a
  real subcontracting pest-control company, not a subsidiary/division of R&M.
- **UI + DB verification (2026-09-23, later same day)**: logged into the real
  confirm the OFO import, not just query the database. Found and fixed a
  real bug the DB-only checks had missed: the zone-seeding script looped
  over its candidate list 2-4 times, creating **145 completely empty
  duplicate zones** alongside the 124 real ones (same display names, e.g.
  "Briggs (OneFortyOne)" showed 7 times in the live Zones page — 3 real,
  from genuinely distinct historical forest codes `BRIG`/`BRIGG`/`BRIGGS`,
  and 4 pure duplicate artifacts with zero code ever pointing at them).
  Verified zero references anywhere (`observations`, `location_events`,
  `parent_zone_id`, `workshop_work_orders`, `service_agreement_locations`)
  before removing them. `location_zones` has a permanence trigger
  (`tg_place_permanence`, ruling 2026-09-15) that blocks a raw `DELETE` —
  owner then explicitly authorized deletion during active build/seeding
  ("we want a clean db"), recorded as a new dated canon correction in
  `docs/canon/LOCATION_HOUSE_MODEL.md` adding a narrow, explicit
  `active_build_cleanup` opt-in scope to that trigger (migration
  `20260923130000_active_build_cleanup_place_delete_scope.sql`) rather than
  silently bypassing it. Final OFO zone count: 131 (124 new + 7
  pre-existing), all active, all genuinely distinct.
- **Lesson for future zone-seeding scripts**: always store the source code
  (the actual distinguishing identifier, e.g. OFO's forest code) in the
  zone's `metadata` at creation time, not just the display name — several
  source codes can legitimately share one plain-English name, and without
  the code preserved on the row there is no way to tell them apart once
  created. Also: dedupe the candidate list by intended output (one zone per
  unique code) before looping, and sanity-check the resulting row count
  against the expected candidate count immediately after seeding, before
  moving on to the next step — this bug would have been caught in seconds
  right after creation instead of being found later during a UI pass.

## PHASE 2 RUN AGAINST TPFL/Tasman Pine Forest (2026-09-23) — 16th client

- TPFL's own file ("ACTIVE TasmanPineForest camera and patrol TPFL.xlsx",
  same List+Summary+year-DATA shape as OFO) had 9,650 real rows across 2025
  (7,435) + 2026 (4,494). 25 of its forest codes matched TPFL's 26
  already-seeded zones directly (Dovedale had no corresponding code in this
  file — fine, just no patrol history recorded against it in this
  particular log).
- 6 new real zones needed, found by cross-referencing real row content (not
  guessed): Harakeke and Mahana (real named forests on TPFL's own List sheet
  that simply weren't seeded yet), a general/admin catch-all (matching
  OFO's own convention), Fringed Hill and Inwoods (real, substantial
  activity — camera installs/activations — missing from the List sheet
  entirely), and Rabbit Island (a real place TPFL patrols independently of
  TDC's/PF Olsen's own separate Rabbit Island zones — same "don't invent
  cross-org shared zones" precedent as before).
- Found real evidence TPFL and OFO are adjacent forestry estates with some
  shared/boundary infrastructure: one row's comment literally reads "Remove
  OFO lock and resecure gate". Three low-volume codes (`NORR`, `BERR`,
  `SPOO`) that coincidentally reuse OFO's own code letters were checked
  against real row content first — all three point at TPFL's own existing
  "Spooners Forest (TPFL)" zone (Spooners Top Rd Nth/Sth, Spooners Gate),
  not OFO's unrelated Norris/Berrymans zones — rolled up into that existing
  zone rather than creating confusing near-duplicates. 6 more rows across 4
  other low-volume codes (`SMIT`, `CULL`, `DONA`, `SERP`, `WAIR`) had no
  strong content evidence either way and were deliberately left unmapped
  (skipped, not guessed).
- Fixed the same class of importer gap OFO needed: added `'Job Time TPFL'`
  / `'Job KM TPFL'` as header picker candidates (TPFL's file uses the
  per-client-suffixed convention, not OFO's bare `Job KM`).
- Result: 509 observations + 9,107 location_events, verified live (0
  garbage plates, 0 duplicate refs). `distance_km` populated on 509
  observations (1,622.9km) and 9,107 location_events (94,511.1km).
- Learned this run: seed new zones one at a time from an explicit, small,
  hand-reviewed list (not a loop over every candidate in a reference sheet)
  — avoids the OFO duplicate-seeding bug entirely by construction, no
  cleanup needed afterward.
- Still open: none (OFO Culling Log 2023 done, see below). A mis-filed TPFL
  in-house pest-control kill-return log was found while looking for it (see
  below) and is deferred as a separate future item.

## OFO Culling Log 2023 (2026-09-24) — pest-control compliance records, hunter-vs-staff identity care

- No file literally named "OFO Culling Log 2023" exists; the real source
  turned out to be **three** small files under R&M's OneDrive
  `OFO\Pest Control` / `OFO\Culling` folders, totalling 26 real events (close
  to the ~23 originally estimated):
  1. `Pest Control Kill Return.xlsx` (Berrymans, 6 real rows) — informal
     kill-return format (Forest/Date/species-counts/Hunter name/Comments), no
     job-time/cost/km tracking at all.
  2. `Berrymans Goat Culling .xlsx` (12 real rows, 1 pure-totals row
     correctly excluded) — correspondence-driven organised cull operation,
     authorised by OneFortyOne (Liam Watson) addressed to "Admin Remsec",
     GL-coded, job-time/km tracked.
  3. `August goat cull_CANV and WILS.xlsx` "Data" sheet (8 real rows) — same
     header shape as OFO's main patrol log (Patroller/Date/Forest/Job Time/
     Job KM/Job Cost), R&M patrol staff performing organised culls as part of
     a paid, cost-tracked operation.
  - A fourth candidate, `Pest Control kill returns .xlsx` (334 rows, labelled
    "R&M Pest Control"), was found in the same OFO folder but its forest
    codes (Pearse/Orinoco/Greenhill/Waimea) are **TPFL's real zone codes**
    (confirmed against `scripts/data/zone-maps/tpfl-zone-map.json`) — this is
    a mis-filed TPFL record, not OFO's. Deliberately excluded from this
    import; deferred as its own future TPFL task rather than misattributed to
    OFO's compliance record.
- All 4 zone codes needed (BERR/CANV/WILS/ALLF) already existed as real OFO
  zones (Berrymans, Canvastown, Wilsons, General/All Forests) — no new zones
  to seed, unlike every other client this session.
- **Identity care (owner-flagged mid-task):** names appearing in a culling
  log are not automatically R&M staff — some are genuinely independent
  hunters/permit-holders who may already have a `canonical_people` record
  (the same registry `person_permits` uses for OFO's 141 RAMS hunting
  permits). Checked before attributing:
  - `canonical_people` has surname-only records "Crawford" (permit
    #16967/#17249) and "Porter" (permit #17014) under OFO — but with no
    first name, forest_areas, or other corroborating detail, there was not
    enough evidence to safely link these to "Rob Crawford"/"Dave Porter" as
    the SAME people (a false merge would misattribute an independent
    hunter's personal activity as R&M staff work, or vice versa — exactly
    the kind of accountability-anchor error FOUNDATION.md warns against).
  - Resolution used the FILE'S OWN structure as the deciding evidence, not
    name-matching alone: the Kill Return file has zero cost/job-time
    tracking and no correspondence — a genuinely informal/personal-capacity
    report — so **every row was imported with Patroller left blank**
    (no officer_id, no canonical_person_id), with the reported name kept as
    plain text in the comments plus an explicit "unattributed, see identity
    note" caveat. The Berrymans and August-cull files are unambiguously
    R&M's own paid, cost-tracked, correspondence-authorised work (GL codes,
    job-time/km, "Admin Remsec" as the contracted party) — there, known
    R&M staff (Rob/Pete Crawford, Dave Porter, Wade Sutherland-Berkett)
    were attributed via the existing `KNOWN_OFFICERS` map as usual. Steve
    Savage and Sheryl Murray matched neither `KNOWN_OFFICERS` nor
    `canonical_people` anywhere — left unattributed with raw name preserved,
    no id invented for either.
  - Lesson: when a name could plausibly be either R&M staff or an
    independent member of the public, judge by the **surrounding record's
    own structure** (paid/cost-tracked/correspondence-authorised vs
    informal/untracked/no correspondence) rather than by name-matching
    alone, and when genuinely unresolvable, leave it unattributed rather
    than force a link either way.
- Zone-map: `scripts/data/zone-maps/ofo-culling-zone-map.json`. Client codes:
  `OFOCULLKR` (Kill Return), `OFOCULLBERR` (Berrymans Goat Culling),
  `OFOCULLAUG` (August cull) — all distinct from OFO's main `OFO2025`/
  `OFO2026` codes, confirmed via live query before picking them.
  Live-verified: 0 duplicate `external_ref`s across all three; `OFOCULLKR`
  0/6 staff-attributed (correct), `OFOCULLBERR` 1/12, `OFOCULLAUG` 7/8 (both
  correct per the identity reasoning above). 0 observations / 26
  location_events total (no vehicle plates in culling data, matching the
  MPC pest-control pattern).
## R&M staff roster history (2026-09-24) — real historical roster captured

- Found `RMSEC Forestry Staff Rosters\Roster.xlsx` — a real, continuous
  Date x patrol-beat shift record from 2022-07-31 to present, independent
  of any client patrol log. Full analysis in repo memory
  `/memories/repo/rm-staff-roster-history.md` (read that file for the
  complete name-by-name breakdown; this is the summary).
- Used the roster to CONFIRM two identities that were ambiguous purely by
  first name: "Colin" = Colin Eathorne (not Colin Nelson, via consistent
  "Colin & Susan" pairing with the already-known Susan Finigan), "Rob" =
  Rob Crawford (via "Rob/Deb" pairing with the already-known Deb Crawford).
- Found two real, substantial officers with NO existing `user_profiles`
  record at all: **Steve Savage** (~Nov 2023-Aug 2024, corroborated by the
  OFO Berrymans culling log) and **Sheryl Murray** (occasional driver/
  support, corroborated by the OFO August-cull log). Created profile-only
  `user_profiles` rows for both (same no-login pattern already used for
  Glenn Gribben/Dan Douglas/A Goodall — `user_profiles.id` has no FK to
  `auth.users`), added both to `KNOWN_OFFICERS`, and retroactively
  re-attributed the one `OFOCULLBERR` row and one `OFOCULLAUG` row that had
  named them but were left unattributed at import time (no profile existed
  yet then).
- Found one real, substantial officer ("**Waz**", ~Jan-Dec 2023, ~89
  mentions) with NO surname anywhere in any file checked — deliberately
  NOT guessed at first (overlaps in time with "Wade" as a DISTINCT tally,
  so is very likely a different person, not a nickname). Owner asked for a
  **placeholder** profile (`display_name` "Waz Waz") to be created now,
  pending real-name confirmation from the Crawfords — created and added to
  `KNOWN_OFFICERS` as `'waz'`; both need updating once the real name lands
  (see `/memories/repo/rm-staff-roster-history.md` for the exact TODO).
- Corrected the first historical-roster projection after review: task-ledger
  rows are evidence, not roster slots. The dedicated roster now imports
  2,135 date/beat assignments (1,888 Nelson, 247 Blenheim), with 920 missing
  dates supplemented from field evidence. The correction removed all 639
  superseded `roster_slots`, created no shifts or notifications, and preserves
  hashed unresolved cell values plus source provenance in `roster_assignments`.
- **Cycle Trails + MPC pest-control log, same day**: both genuinely belong
  to TPFL (Cycle Trails' GL codes are TPFL's own "8558-" family; MPC's DATA
  sheet's own `Company` column literally reads "TPFL" for every real row —
  R&M's own note confirms this is TPFL's pest-control activity performed by
  Mainland Pest Control as subcontractor, not a separate client). Both
  imported entirely against TPFL's EXISTING zone-map — zero new zones
  needed for either. Cycle Trails: 247 real rows, all but 32 blank-Forest
  ones coded `SPNR` (Spooners) — 3 observations + 211 location_events.
  MPC: 64 real rows across 4 already-known TPFL codes (MTRN/RICH/RIWA/LINK)
  — 0 observations (pest-control work has no vehicle plates to detect, only
  presence/activity), 44 location_events. Both live-verified clean (0
  garbage plates, 0 duplicate `external_ref`s) against TPFL's whole org.

## OFO field-ledger roster projection (2026-09-27) — two forestry patrols seeded

- The large OneFortyOne workbook was **not reopened**. The source was the
  provenance-bearing OFO2025/OFO2026 evidence already imported into
  `location_events` and `observations`; the new pipeline does not parse the
  workbook a second time.
- Migration `20260927100000_project_historical_patrol_roster.sql` adds the
  postgres-only, audited `project_historical_patrol_roster(...)` command.
  `scripts/seed-historical-patrol-roster.mjs` is dry-run-first and the checked-in
  `rm-ofo-forestry.json` config defines the two owner-requested assignments:
  **Nelson Forestry Patrol** and **Blenheim Forestry Patrol**.
- Live applied result: 2 active `patrol_routes`, 2 active patrol
  `roster_work_units`, 119 missing active OFO agreement-location links repaired,
  34 source-backed route zones attached (33 Nelson, 1 Blenheim), and 639
  completed historical `roster_slots` (638 Nelson, 1 Blenheim) covering 8
  resolved R&M staff from 2024-12-22 through 2026-09-22.
- Every slot carries its source event references in `external_refs`; all 639
  are `completed`, none has a linked shift, no slot exceeds 24 hours, there are
  zero overlapping projected slots, zero duplicate request IDs, and exactly one
  projection audit receipt. Replaying the same request returned the same receipt
  and created nothing else. R&M's pre-existing live shift count remained 1.
- The projection is deliberately honest about remaining gaps: 1,394 imported
  staff-event candidates do not resolve to a current R&M staff profile, 4,542
  events have neither an authoritative place coordinate nor a geocoded parent
  estate, and 73 events reference places that could not be linked as active OFO
  agreement coverage. They remain unprojected rather than being guessed into a
  regional route.
- This seed creates **history and reusable route/work-unit structure only**.
  It creates no future roster schedule, no shifts, and no identities. Future
  cadence/windows still require an approved delivery schedule through the normal
  CRM/roster path.

## Digger work order (OFO, 2026-09-24) — workshop maintenance zone_id constraint bug found and fixed

- Real source: `REMSEC Digger work 2023.xlsx`, 1 row — Rob Crawford, Te Hepe
  forest (OFO), digger trenching to secure a gate against unauthorised
  entry, 3hrs @ $215/hr = $645, GL 8558-74500-055, work performed
  2023-12-20 (Excel serial 45280).
- First attempt via `create_workshop_work_order` (`p_zone_id` set to the
  Te Hepe zone) failed on `workshop_actor_org()`'s `Active user required`
  — fixed by wrapping the RPC call with
  `SET LOCAL request.jwt.claim.sub = '<assignee user id>'` in the same
  query batch (needed because these live-DB scripts call the Management
  API directly with no real Supabase Auth session).
- Second attempt failed on `workshop_work_orders_maintenance_needs_place`:
  `CHECK (kind <> 'maintenance' OR client_site_id IS NOT NULL OR asset_id
  IS NOT NULL)` — a real, previously-undetected gap. Zone support
  (`zone_id` column + RPC overload) was added to the Workshop module
  earlier the same day, but this CHECK constraint was never updated to
  accept it. A forest zone has no LINZ address and is never a "site", so
  every zone-anchored maintenance work order was silently unbookable until
  this was the first real attempt to create one.
- Fixed via migration
  `20260924000000_workshop_maintenance_zone_place_constraint.sql` (drop +
  recreate the constraint, adding `OR zone_id IS NOT NULL`). Applied live,
  `supabase/schema.sql` regenerated, Atlas refreshed (0 capability/edge
  changes — function-body-only, expected), full `apps/web` test suite
  re-run clean (298 files / 1278 tests).
- Work order created successfully: `WO-202609-0002`, kind `maintenance`,
  status `draft`, `zone_id` = Te Hepe, assigned to Rob Crawford,
  `scheduled_for` = `2023-12-20 13:00:00+13` (confirms the Excel-serial →
  UTC conversion formula used elsewhere this session is correct).
- Lesson: when extending any table/RPC to accept a new "place" type
  alongside existing ones (`client_site_id`/`asset_id`/`zone_id`), audit
  *every* CHECK constraint referencing the old set in the same migration —
  don't wait for a live usage attempt to discover the gap.

## Investigation system hardening (2026-09-24) — building it out for real trespass-dispute data

- Found Wrattens' real patrol log (`ACTIVE Wrattens Camera and Patrol WRAT.xlsx`)
  contains a genuinely serious, real, multi-month neighbour dispute: Ron/Sue/
  Richard Post (active trespass notice, alleged threats quoted directly, an
  aggressive-driving Police file that led to a conviction, a poaching Police
  file, alleged deliberate harassment/property damage) and a separate Mary-Ann
  Carr easement/access dispute (also active trespass notice, explicit legal
  threats) — plus two already-closed matters (Faulknor burglary, Lummis/
  Renish fuel theft) tangled into the same raw log. Real PII throughout:
  phone numbers, personal emails, a physical address, vehicle plates, direct
  quotes of alleged threats, and live correspondence with two named Motueka
  Police officers.
- Researched both external enterprise-investigation patterns AND this
  build's own prior design work before touching anything (`docs/
  DEEP_BUILD_AUDIT_2026-09-08.md`, `docs/ENTERPRISE_COSTING_AND_PNL_DESIGN.md`,
  `docs/SAMPLE_DATA_EXPANSION_REVIEW.md`) — the `investigations`/
  `investigation_events`/`investigation_links` system already exists
  (migration `20260907001000_investigation_workspace_and_followup_dispatch.sql`)
  and already has real, already-documented gaps blocking safe use for real
  third-party data:
  - `link_investigation_entity` accepted ANY `entity_id` for entity types
    other than `field_report`/`incident` with zero existence/org check
    (High finding, 2026-09-08, unfixed until now) — exactly the path this
    session needs for `entity_type='person'` (named dispute parties).
  - `create_investigation`'s `p_lead_user_id` wasn't validated same-org.
  - All 3 tables were flat `org_access_allowed` SELECT — any R&M staff
    member could read full dispute narrative/PII; no tiering at all.
- Fixed via `supabase/migrations/20260924010000_investigation_workspace_hardening.sql`:
  - Added `'trespass'` to `investigation_type` (Post/Carr disputes didn't
    fit any existing value).
  - `link_investigation_entity` now verifies the entity really exists (and,
    for org-scoped types, belongs to the investigation's own org) before
    linking — `canonical_people`/`canonical_vehicles` are checked for
    existence only, since they're the cross-org identity spine, not
    org-scoped facts.
  - `create_investigation`'s lead_user_id is now validated same-org.
  - Base tables tightened to admin-or-assigned-lead-only SELECT (matches
    the existing `person_permits`/`person_permits_fieldwork` tiering
    pattern); added `investigations_summary` — a redacted, `org_access_
    allowed`-visible view (reference/type/status/dates only, no narrative)
    so ordinary staff can see an investigation exists without reading the
    sensitive detail.
  - Live-verified: a bogus entity id is now rejected with a clear error; a
    real `canonical_people` id still links successfully. Schema/Atlas
    regenerated, full `apps/web` suite green (298/1278).
- **Not yet done**: the real Wrattens import itself — 4 separate
  investigations (Post `trespass`/`legal_hold`, Carr `trespass`/
  `legal_hold`, Faulknor `other`/closed, Lummis-Renish `other`), real
  `canonical_people` for every named party (Post family, Carr, the two
  named Police officers, Faulknor, Lummis, Renish), linked via the now-
  hardened RPC, with the raw log rows imported as `investigation_events`.
  This is the immediate next step.

## Real Wrattens investigation import (2026-09-24) — the proof case, done

- Found a real, still-open gap while building this: there was no governed
  way to add a human-authored narrative event to an investigation's
  timeline at all — the original design only ever auto-generated
  `investigation_opened`/`entity_linked` events as side-effects of the two
  existing RPCs. Added `add_investigation_event(p_investigation_id,
  p_event_type, p_description, p_occurred_at)` in
  `supabase/migrations/20260924020000_investigation_add_event_rpc.sql`,
  gated identically to reading the timeline (admin-or-assigned-lead).
- **Scope decision**: anchored the 4 real investigations to R&M's own
  organization (`e96d71c9-...`), not a new "Wrattens" client org. Wrattens
  has never been seeded as its own org/site/zone in this build (unlike
  every other R&M client) — doing that properly (LINZ geocoding, boundary
  work, the full patrol-log backfill) is its own real task, not a rushed
  side-effect of proving the investigation system. A private-investigation
  case file is legitimately the operator's own work product regardless
  (`docs/canon/ALIGNMENT_LEDGER.md` Bucket C reasoning) — the place (Brooklyn
  Rd) and client (Wratts family) are captured in the investigation's own
  title/summary text instead. Seeding Wrattens as a full 17th client is
  deferred, tracked here for whoever picks it up next.
- Created 12 real `canonical_people` (Kerryn Wratt, John Wratt, Kasia
  Grela, Ron/Sue/Richard Post, Mary-Ann Carr, Constables Reuben McCormack
  and Scott Satherley, Max Neilson Faulknor, Greg Lummis, Steven Renish),
  4 investigations (`WRAT-POST-2023`, `WRAT-CARR-2023`,
  `WRAT-FAULKNOR-2022` closed, `WRAT-FUELTHEFT-2022`), 14 entity links
  with real `link_role`/`link_reason` (subject/complainant/witness/Police
  liaison distinctions preserved in the reason text since `link_role`
  itself only has 5 coarse values), and 35 real narrative
  `investigation_events` with real dates (Excel-serial converted) —
  concise factual summaries of the real correspondence/Police
  reports/camera activations, not verbatim email dumps, per the "governed
  proposal, human review before promotion" principle already ratified in
  `docs/SAMPLE_DATA_EXPANSION_REVIEW.md`/`docs/ENTERPRISE_COSTING_AND_PNL_
  DESIGN.md`.
- Rob Crawford set as `lead_user_id` on all 4 (he's the one actually
  handling Police liaison/correspondence in the real source).
- **Verification limitation found and recorded**
  (`/memories/terminal-quirks.md`): the Supabase Management API's SQL
  endpoint bypasses RLS entirely regardless of `SET LOCAL request.jwt.
  claim.sub`, so it cannot prove read-access tiering actually works end to
  end — only the policy definition (already confirmed via `pg_policies`)
  and SECURITY DEFINER function logic (genuinely provable, since it checks
  `auth.uid()` in code) can be verified this way. A true end-to-end proof
  needs a real authenticated browser session as a non-admin, non-lead
  officer.
- Schema/Atlas regenerated (668 functions, +1 RPC; Atlas: 4 capabilities,
  3 edges), full `apps/web` suite green (298/1278).
- **Found and fixed a real, pre-existing frontend gap while verifying this**:
  the "Investigations" nav link rendered `InvestigationPage.tsx` with no
  `?id=`, which always immediately errored ("An investigation id is
  required") for every user, always — there was no way to actually discover
  an investigation from the UI at all before today, regardless of the RLS
  work. Also confirmed the access tiering has a real (correct, fail-closed)
  frontend consequence: an ordinary officer opening an investigation they
  aren't admin/lead on now hits PostgREST `PGRST116` (0 rows via
  `.single()`) instead of seeing full content. Fixed both in
  `apps/web/src/pages/InvestigationPage.tsx`: added a real list view backed
  by `investigations_summary` (safe for everyone) with click-through to the
  existing detail view, and replaced the generic "could not be loaded"
  message with a specific "you don't have access — only an admin or the
  assigned lead can open this" message when `PGRST116` is the cause. Full
  `apps/web` suite green, real production build (`npm run build`) verified
  clean (per the standing lesson that vitest alone doesn't prove the app
  builds).

## Wrattens full client seeding (2026-09-24) — 17th and final client, the deferred item closed

With the investigation workspace hardening done and proven (previous section),
the reason Wrattens was deferred no longer applies. Seeded Wrattens as a real,
full client org — the last item from the original "seed all the sites" mandate.

- **Org + zones + agreement created live**: `organizations` row `Wrattens
  (Wratt Family Farm)` (`f1a9fa3b-05f3-4489-be78-7e129a7f1e86`), 3
  `location_zones` built through the full `canonical_places` -> `locations`
  -> `location_zones` chain (the same 3-level pattern OFO's real "Te Hepe"
  zone uses - zones do not require a `client_sites` row, they can hang
  directly off `locations`): Brooklyn Rd (`e5950b3b-...`), Moutere Hill
  (`2a309793-...`), and a General/Private catch-all (`04fa1405-...`) for rows
  whose Forest code didn't cleanly resolve to either named property. One
  `service_agreements` row (`ad2a5116-...`, `agreement_type='operational'`,
  R&M as provider) linking them.
- **Real forest codes extracted directly from the 3 raw data sheets**, not
  from the unreliable "List" reference sheets (already-established rule: the
  List sheet's Reserve Name/Code columns are not row-aligned with the DATA
  sheet's real code usage). True distinct codes found: `BROO` (Wratts sheet,
  37 raw rows), `WRAT`/`MTRN` (Wrattens sheet, 292/1 raw rows), `PRIVATE`/
  `WRATT` (2025 sheet, 7/2 raw rows out of 250 - mostly blank). Zone map
  written to `scripts/data/zone-maps/wrattens-zone-map.json`.
- **Patrol log imported via the existing `scripts/import-patrol-log.mjs`**,
  no script changes needed - it already handled this exact CSV/zone-map/
  client-code shape. Three sheets, three `--client-code`s (`WRATBROO`,
  `WRATMTR`, `WRAT2025`) to keep `external_ref`s from colliding:
  - Brooklyn Rd: 3 observations, 33 events (261 rows parsed, 225 skipped -
    no date, 0 skipped - no zone).
  - Moutere Hill: 6 observations, 284 events, 3 events skipped as genuine
    within-file duplicates (296 rows parsed, 3 skipped - no date).
  - 2025 sheet: 1 observation, 7 events (249 rows parsed, 230 skipped - no
    date, 11 skipped - no resolvable zone; this sheet is mostly blank).
  - Totals: 10 observations, 324 events, spanning 2021-01-04 to
    2025-03-27. Live-verified clean: 0 garbage plates, 0 duplicate
    `external_ref`s across the whole org.
- **Real content directly corroborates the 4 investigations already built**
  as this session's proof case - e.g. the actual imported observation text
  names "LUMMIS/Greg" and "RENISH/Steven" and "Reg HCM901" for the fuel-theft
  matter, and real camera-activation/correspondence events name Ron/Sue/
  Richard Post and Mary-Ann Carr directly against the Brooklyn Rd zone.
- **Investigation-to-zone linking evaluated, deliberately NOT applied - a
  real architectural finding, not an oversight.** The 4 real Wrattens
  investigations are anchored to R&M's own provider org (a private-
  investigation case file is the operator's own work product, per the
  existing Bucket C reasoning already recorded above), while the zones just
  created belong to Wrattens' own client org. `link_investigation_entity`'s
  org-match validation (added in the hardening migration two sections up)
  correctly rejects linking an investigation to a `zone`/`site` entity that
  belongs to a *different* org than the investigation itself - this is the
  same protection that migration was written to add, not a bug to route
  around. Loosening it to allow cross-org zone links would reintroduce the
  exact boundary-crossing risk just closed, for a "nice to have" link that
  isn't otherwise needed: every investigation's title/summary text already
  names the real physical location accurately (Brooklyn Rd / Moutere Hill /
  236 Hoddy Road Redwood Valley), and person-entity links (which are
  correctly exempt from the org-match check, since `canonical_people` is a
  genuine global cross-org identity spine) already anchor each case to its
  real named parties. Specifically checked and confirmed with real evidence
  before deciding this, not assumed:
  - Post + Carr: real camera-activation/correspondence events naming them
    exist directly against the Brooklyn Rd zone - a positive match, but
    still correctly blocked by the org boundary.
  - Fuel theft (Lummis/Renish): the real "Log 158" observation lands in the
    Moutere Hill zone - same situation.
  - Faulknor (236 Hoddy Road, Redwood Valley): the only "Hoddy" mention
    anywhere in the imported Wrattens data is an unrelated commercial
    vehicle registration address (68 Hoddy Rd, Richmond - Galeo Contracting
    Ltd) that coincidentally shares the street name. No real evidence ties
    this closed case to any of the 3 seeded zones at all, so per the
    standing "don't force/guess a place" principle it was never going to be
    zone-linked regardless of the org-boundary question - its existing
    `canonical_people` link (Max Neilson Faulknor, already `verified`) is the
    correct and sufficient anchor.
- No schema/RPC/policy change was needed for this phase (pure data import
  against already-hardened, already-tested infrastructure) - schema.sql/
  Atlas were not regenerated because nothing changed that they track.

## Next phase: finance/km pipeline shakedown (2026-09-24) - first slice done

With every real client seeded and patrol history imported, the mandate moved
to its final stated goal: "make sure the entire build can actually work with
a working org and its data and operations." Unlike the historical-data work
above, this phase is about R&M's *live* operational tools - dispatch,
rostering, finance/invoicing, reporting - which is a genuinely different kind
of surface (forward-looking scheduling/billing, not retrospective backfill).

**Reconnaissance first**: R&M's live operational tables were almost entirely
untouched before this phase - 0 shifts, 0 roster_slots, 0 finance_service_costs,
0 monthly_report_packs of R&M's own, and exactly 1 dispatch_job (a minimal
`status='completed'` smoke-test row from 2026-09-18 with zero elapsed time and
no GPS, proving the function didn't crash but exercising none of the real
per-km/GPS logic). R&M does have a real, rich **billing** rate card (19 real
`rate_rules`, `rule_kind='billing'`, real 2025 pricing incl. two per-km rules
at the IRD Tier 1 rate $1.04/km) but only **one** `rule_kind='pay'` rule (a
flat $30/hr guard wage, no vehicle/travel cost rule at all).

**Real architectural finding, not a bug**: the historical `distance_km` this
session imported into `observations`/`location_events` (patrol-log backfill,
retrospective analytics) and the *live* per-job travel distance used for
billing (`compute_travel_distance_km`, a haversine calc between a dispatch
job's `insert_gps_lat/lng` and the site's coordinate, run once at job
completion) are two separate, both-legitimate mechanisms that serve different
purposes. They should not be conflated or forced to reconcile.

**Live verification performed**: created ONE real, clearly-labeled
verification dispatch job for R&M against a real service agreement (R&M and
OneFortyOne, `c36761e5-...`) and a real site with real coordinates
(OneFortyOne - Kaituna Sawmill), a realistic dispatch-origin coordinate
(OneFortyOne's own Richmond office, ~55km away - real, existing
infrastructure, not invented), and a realistic 50-minute on-scene duration.
Advanced it through the real production state machine
(`advance_dispatch_job_status`: pending -> dispatched -> en_route -> on_scene
-> completed) as a real admin actor (Rob Crawford), letting the real,
automatic `resolve_dispatch_job_financials_internal` trigger fire on
completion exactly as it would for a genuine job. Result: **haversine
distance computed correctly (54.839 km, matching a manual estimate)**, the
real hourly guard pay rate and per-km IRD billing rate both resolved and
computed correct real dollar amounts ($25.01 labour pay, $57.03 travel
charge). Deleted the test job and its generated pay/charge lines immediately
after capturing results - confirmed there is no automatic invoicing cron
(invoicing requires an admin to explicitly run
`create_invoice_from_completed_work` for a specific client/period, producing
only a `draft` invoice), but a stray real-looking charge sitting in a real
client's uninvoiced-work queue serves no purpose and could confuse a real
R&M staffer reviewing "ready to invoice" work.

**Two real, evidence-backed findings from that verification**:

1. **Job-type billing-coverage gap (revenue-affecting, reported not
   silently patched)**: of R&M's 5 real dispatch `job_type` values actually
   in use (`patrol_support`, `trespass`, `noise_control`, `incident`,
   `alarm_response`), only `incident` and `alarm_response` have a billing
   rule keyed directly to `job_type`. The rest of R&M's real billing rules
   are keyed to `service_type` (`patrol`, `cordon_guard`, `investigation`,
   etc.), which is only available as a fallback when the dispatch job is
   linked to a shift with that `service_type` set. A standalone
   `patrol_support`/`trespass`/`noise_control` job with no linked shift -
   which is a realistic real-world scenario (an ad-hoc callout with no
   roster tie-in yet) - resolves to an "Unresolved: no active hourly charge
   rule matched" $0 line, correctly flagged for finance review rather than
   silently mis-billed, but a genuine attendance-revenue gap all the same.
   No fix applied - this needs a real R&M ops/finance decision (what should
   these job types bill at, or should ops always link a shift instead),
   not an invented number.
2. **Pay-side vehicle cost gap (margin-blind-spot)**: because R&M has no
   `rule_kind='pay', rate_type='per_km'` rule, the same function's own
   "feed travel cost into the P&L cost ledger" bridge (writes to
   `finance_service_costs`, `cost_type='vehicle'`, only when a pay-side
   per-km rule resolves) never fires - real vehicle running cost never
   reaches R&M's own P&L for any job with billed travel. Every travel km
   already correctly charged to a client is currently pure margin on paper,
   because the corresponding cost is invisible. **Action taken**: rather
   than directly inserting a live `rate_rules` row (a real financial-policy
   decision I'm not positioned to make unilaterally for a real paying
   customer), used the existing governed propose-approve-apply mechanism
   already built for exactly this (`bob_agentic_actions`,
   `action_type='create_rate_rule'`, applied only via
   `apply_bob_rate_rule_proposal` after an active finance admin approves -
   confirmed this surfaces on the real `ApprovalsActivityPage.tsx`, whose
   `ApprovalRow` interface matches the table shape exactly). Created ONE
   `status='pending'` proposal (`9d7159b2-...`) for a $1.04/km pay-side
   vehicle rate - the same IRD Tier 1 rate R&M already uses identically on
   both of its existing per-km *billing* rules, so it's a defensible,
   already-precedented default, not an invented figure - with full
   `bob_reasoning` recorded. Left `status='pending'`; nothing about R&M's
   real cost model changed without a human approving it first.

**Still open, not yet done** (next slice of this phase): the same
live-verification treatment for the dispatch console UI itself and for
reporting (`monthly_report_packs`/`ReportsHubPage.tsx` - currently zero
report packs generated for R&M).

## Both findings closed (2026-09-24, same day) - real approval bug found + fixed, real shifts created

**User approved the pay-rate proposal in the live UI - and that approval
itself uncovered a second, systemic, previously-latent bug.** Checking the
result of the real approval (not assuming success) showed the action's
`status` was `'failed'`, not `'applied'`, with error `"apply_bob_rate_rule_
proposal failed: An active finance administrator approval is required"` -
even though a real R&M master (Don Squires) had genuinely just approved it.

**Root cause traced to source, not just the symptom**: the live "Approve &
apply" flow calls a SEPARATE edge function, `bob-proposal-execute`
(`supabase/functions/bob-proposal-execute/index.ts`), using the
SERVICE-ROLE key by design (its own doc comment: "the executor is
service-role-only"). `apply_bob_rate_rule_proposal`'s internal admin check
called `is_admin_for_org(...)`, which resolves entirely from `auth.uid()` -
and `auth.uid()` is always NULL under a service-role-only call. This means
the check could **never** succeed, for any organization, any user, ever -
not a one-off fluke tied to R&M or to Don Squires. Confirmed unconditional
by re-testing the unfixed function with `auth.uid()` deliberately null via
the Management API (same failure), then confirming the fixed version
succeeds under the identical null-auth.uid() condition.

**Fixed with a minimal, evidence-matched change**
(`supabase/migrations/20260924030000_fix_apply_bob_rate_rule_proposal_actor_
check.sql`): replaced the `is_admin_for_org(v_action.organization_id)` call
with `can_approve_action(v_action.approved_by, v_action.organization_id)` -
an already-built, already-tested function that takes an explicit user id
instead of relying on `auth.uid()`, and is the SAME function
`bob-proposal-approver` already uses earlier in this exact approve/apply
flow (so this reuses existing, proven authorization logic rather than
inventing a parallel check that could drift). Applied live via
`scripts/apply-migrations-live.mjs`, verified the new function definition is
live, then verified it actually succeeds under the exact null-auth.uid()
condition that broke the old one. Reset the one real failed action back to
`status='approved'` (the human approval itself was genuine; only the apply
step had failed) and re-ran it - produced a real, live `rate_rules` row
(`b4a32969-...`, `rule_kind='pay'`, `rate_type='per_km'`, `$1.04/km`,
wildcard `service_type`/`job_type` so it matches broadly). Completed the
action-ledger bookkeeping (`status='applied'`, `result_table='rate_rules'`,
`result_record_id`) that the edge function would normally have done, since
the RPC was invoked directly rather than through the (separately broken by
an unrelated stale-local-credential issue, not a code bug) edge function
call. `schema.sql`/Atlas regenerated; no frontend/TypeScript code changed,
so the `apps/web` test suite was not re-run.

**Then created the real shift infrastructure the user asked for**, closing
the OTHER open finding (the job-type billing-coverage gap) via the option
the user chose (link a shift) rather than inventing a new job-type-keyed
rate: a real `patrol_routes` row (R&M, OneFortyOne - Kaituna Sawmill site,
`route_type='patrol'`, no invented data), a real `roster_work_units` row
(`work_unit_type='patrol'`, `service_type='patrol'`, linked to that route -
required by a real DB constraint, `roster_work_units_exact_target_check`,
that a `'patrol'` work unit must have a `patrol_route_id` and no other
target FK), and one real, clearly `[TEST]`-labeled verification shift for
Colin Eathorne (`status='accepted'`, matching the exact "safe to leave in
place" convention already found elsewhere in this live database for
verification shifts). Kept all three as permanent, genuinely reusable
infrastructure - unlike disposable financial test rows, a structural
patrol-route/work-unit/shift is real, reusable organisational data, and this
codebase already has its own precedent for leaving a `[TEST]`-labeled
verification shift in place rather than deleting it.

**Re-verified the complete pipeline against a NEW shift-linked dispatch job**
(same real site/GPS/officer pattern as before, this time with `p_shift_id`
set): both real gaps are now closed, proven with real numbers, not assumed:
- Attendance **charge** line now resolves via the shift's
  `service_type='patrol'` fallback, matching the real "Patrolling (per
  hour)" billing rule - **$45.10** for 0.8336h at $54.10/hr (previously an
  unresolved $0 line).
- Attendance **pay** line: $25.01 (unchanged, already worked).
- Travel **charge**: $57.03 (54.839km x $1.04/km, unchanged, already worked).
- Travel **pay**: **now resolves too** - $57.03 (54.839km x the newly-applied
  $1.04/km pay rate) - previously not written at all.
- **`finance_service_costs` vehicle-cost bridge now fires** -
  `cost_type='vehicle'`, `$57.03`, landed in R&M's real open Sept 2026 P&L
  period. Real, evidenced, non-obvious finding from this exact number: R&M's
  pay-side and billing-side per-km rates are now identical ($1.04/km both
  ways), so travel is currently a wash (reimbursed at cost, zero margin) -
  not a bug, a real fact about R&M's own rate card worth them knowing, not
  something to silently "fix" by inventing a markup.

Cleaned up the second verification job's financial artifacts (pay/charge
lines, `finance_service_costs`, the `dispatch_jobs` row itself) the same way
as the first - kept the shift/work-unit/patrol-route. Final confirmed state:
`dispatch_jobs`=1 (original 2026-09-18 smoke test only), `finance_service_
costs`=0, `shifts`=1, `roster_work_units`=1, `patrol_routes`=1, pay-side
`rate_rules`=2 (original guard wage + the new real vehicle rate).

## Live UI verification with R&M's real master account (2026-09-24) - real bugs found and fixed

User provided R&M's own real master-account credential (`R&M_USERNAME`/
`R&M_PASSWORD` in `deploy/laptop-worker/laptop-worker.env` - the same
`don@ironeagle.co.nz` identity already used as `created_by`/actor
throughout this whole session's R&M work), explicitly authorising its use
for this verification. Logged into the live production build
(`fcmanager.co.nz`) via a disposable Playwright spec and confirmed
`workingInRM: true` - the real R&M master account correctly lands in R&M's
own organisation context (no "Working In" switch needed, unlike the
platform grand_master test identity used in the prior attempt, whose home
org is a structurally unrelated "Iron Eagle Security").

**Four real, evidence-backed findings, all fixed** (per the user's explicit
invitation to "realign or redesign the ui to work to be more user friendly
and simple to use with minimal moving parts"):

1. **Duplicated-word text bug**: `AdminShell.tsx` passed
   `moduleLabel: 'Module configuration'` into `getModuleAccessMessage`,
   whose shared template already appends "configuration is still loading" -
   producing the literal visible text "Module configuration configuration
   is still loading." Every OTHER real caller of this shared function
   passes a bare feature noun (`'Welfare'`, `'Field Reports'`, etc.),
   confirming this call site was the sole, simple mistake. Fixed by
   changing the passed label to `'Module'`.
2. **Loading and genuine-failure states were visually identical**: the
   "Today at a glance" dashboard (`AdminHubPage.tsx`) showed the exact same
   "Unavailable" label for a metric whose fetch simply hadn't completed
   yet (normal first-load latency across 11 concurrent Supabase queries
   against a live production instance) as for a metric whose fetch
   genuinely errored. Confirmed via live network capture that every single
   underlying query actually returns clean `200 OK` for R&M - there was
   no real backend error at all; the "Unavailable" banner a real screenshot
   captured was almost certainly taken mid-flight during the first cold
   round trip. Fixed by threading the existing page-level `loading` flag
   into `MetricCard` (new `loading` prop, distinct `is-loading` CSS class,
   a calmer blue tone instead of the alarming gray "unavailable" look) and
   `displayMetric()` (now returns `'…'` while a metric has never yet
   resolved and the page is loading, only "Unavailable" once loading has
   settled and the value is still null). Never fires on background
   60-second auto-refreshes, since by then `metric.value` already holds
   the last real result.
3. **Roster page couldn't load ANY staff for a standalone provider viewing
   its own organisation** - a genuinely significant, real functional gap,
   not a cosmetic one. `RosterOperationsPage.tsx`'s own gate refused to
   even attempt loading staff unless the operating context's
   `authorityBasis === 'branch_authorisation'`; R&M, viewed as itself, has
   `authorityBasis === 'organisation_home'` (R&M is not part of any
   multi-branch/franchise structure), so the gate always showed "Select a
   delivery branch to view roster operations" and the staff-loading RPC
   was never even called - regardless of how many real staff/shifts
   existed. Confirmed live: the Field Operations page's own separate
   "officers on duty" counter correctly showed 1 (my real verification
   shift), while Roster showed "0 rosterable staff... no rosterable staff
   in this branch yet" for the exact same underlying data - a real,
   confusing inconsistency between two views of the same facts. Root-caused
   two layers deep:
   - Frontend gate too narrow: relaxed to block only
     `'corporate_oversight'` (a read-only view spanning every branch at
     once, genuinely ambiguous which roster to show) - `'organisation_home'`
     now loads staff too, same as `'branch_authorisation'`.
   - The underlying RPC, `get_operating_branch_roster_staff`, only ever
     matched staff via `staff_branch_authorisations` - a table that only
     has rows for multi-branch/franchise customers. R&M has zero such rows
     (it isn't branch-structured at all), so even with the frontend gate
     fixed, the RPC would still return nothing. Fixed additively in
     `supabase/migrations/20260924040000_roster_staff_home_org_fallback.sql`:
     the RPC now ALSO matches a `user_profiles` row whose `organization_id`
     IS the operating org directly (a standalone org's own staff), purely
     as an additional `UNION` branch - every existing branch/franchise
     customer's results are byte-identical, this only adds rows that were
     never returned before for organisations with no branch structure.
4. **R&M's real 22 officers had never been onboarded into `staff_profiles`
   at all** - the deeper prerequisite the RPC fix alone couldn't paper
   over, since its join requires a matching `staff_profiles` row to exist.
   Confirmed live: even after both fixes above, the RPC still returned
   empty, because R&M had zero `staff_profiles` rows full stop (despite 22
   real, already-identity-verified officers existing as `user_profiles`
   rows from this whole session's patrol-log work). Created 23 real
   `staff_profiles` rows (all 22 real `role='officer'` R&M officers plus
   the "Waz Waz" placeholder) with `organization_id`=R&M and the schema's
   own safe defaults (`employment_type='permanent'`). **Deliberately left
   `work_ready` at its honest default (`false`)** rather than setting it
   true for all of them - `work_ready` has its own explicit human-review
   tracking columns (`work_ready_reviewed_by`/`_at`/`_notes`), meaning
   marking someone work-ready is a genuine HR sign-off decision, not
   something to shortcut unilaterally for 22 real people even though the
   circumstantial evidence (years of real patrol history) would likely
   support it for all of them.

**Verified end to end after all four fixes**: `get_operating_branch_roster_
staff('R&M')` now correctly returns all 23 real officers including Colin
Eathorne (matching the real verification shift created earlier this
session). Full `apps/web` suite green (298 files / 1278 tests), real
production build clean (`npm run build`, "built in 1.65s", zero errors).
`schema.sql`/Atlas regenerated. Backend fixes (RPC, `staff_profiles` rows)
are live immediately; the three frontend `.tsx`/`.css` fixes need an actual
build+deploy (the normal push pipeline) before they reach
`fcmanager.co.nz` - re-verifying the LIVE UI specifically for these
frontend changes is a follow-up once deployed, not done in this pass.

## Zone-backed dispatch shakedown (2026-09-26) - production workflow completed

Authenticated production verification used R&M's human-operated master session
and the real Wrattens agreement. No dispatch job was submitted.

- **Before:** Wrattens had three active Zone records and an accepted operational
  agreement, but none of the Zones had an active `service_agreement_locations`
  link. The Dispatch form was Site-only, showed "No active sites", and disabled
  Create. The database reinforced the same limitation: `dispatch_jobs` and
  `create_dispatch_job` had only `client_site_id`, despite the canonical field
  model allowing an existing Site or Zone.
- **During:** migration `20260927060000_dispatch_jobs_site_or_zone.sql` added an
  exact Site/Zone anchor, a governed `create_dispatch_job_for_place` command,
  and a compatibility wrapper for every existing Site caller. Zone context now
  reaches alarm provenance, officer/admin/mobile readers, live-map and route
  guidance, completion distance, Zone-specific pay/billing, and audit evidence.
  The rollback oracle passes six creation, replay, boundary, provenance,
  financial, and compatibility checks against both isolated PostgreSQL and the
  live database. The web suite passes 302 files / 1,309 tests; production web,
  mobile TypeScript, and the Edge Function compile cleanly. Atlas was refreshed,
  and `officer-route-guidance` is ACTIVE at version 19.
- **After:** commit `bbf40074` is on GitHub `main`, and the current production
  dispatch chunk contains the Site-or-Zone selector and place-aware RPC. The
  existing agreement setup UI was then used to link Brooklyn Rd, Moutere Hill,
  and General / Private to the Wrattens agreement through
  `manage_crm_agreement_zone_coverage`; the dialog confirmed **Covered places
  3** and wrote the normal audit receipts. Returning to Dispatch showed all
  three Zones. Selecting Brooklyn Rd enabled Create and matched the live
  `$58.30/hour` billing rule. Create was deliberately not clicked, so the
  shakedown changed agreement coverage only and created no operational job.

The release also reconciled a concurrent migration-ledger collision: the
idempotent identity resolver moved to `20260927051000`, preserving
`20260927050000` for `builder_autopilot_awaiting_human`. Local and production
migration histories were confirmed fully aligned before publication.

## Report review and live-client delivery (2026-09-26) — workflow live, R&M configuration approved

The next reporting slice now has a governed implementation on
`feature/report-pack-review`. Report generation produces provider-private
drafts rather than immediately client-readable packs. Provider administrators
can review source metrics, edit a bounded client-facing title/summary/notes/
follow-up layer, save without releasing, preview a PDF, and explicitly publish.
Publication routes to the live client portal when the client organisation has
an active client login; otherwise the reviewed pack becomes eligible for email.
The email function refuses portal-delivered packs, and drafts are hidden from
client RLS. Sent packs remain immutable.

Evidence completed before deployment: the rollback-only authenticated
database oracle passes 12 provider/client/outsider/concurrency/audit cases;
focused backend contracts pass; Reports Hub guards pass; the production web
build passes; and the review/publish flow passes Playwright at desktop and Pixel
7 viewports with no horizontal overflow or browser errors. Commit `65cd9194`
is on GitHub `main`; migration `20260926010000` is recorded live; both report
Edge Functions are ACTIVE; the live schema snapshot is clean; and Atlas records
`review_monthly_report_pack` as present/wired with its component, table, audit,
agreement, user, and authorization edges. `exercised` remains honestly unset
until an authenticated human runs the real workflow.

The production-readiness check found a configuration prerequisite rather than a
code defect: R&M had 17 accepted operational agreements, all reporting-enabled,
but zero monthly template assignments and zero client-login profiles. The owner
approved configuring all 17 agreements with one reviewed monthly accountability
template, while generating no pack until September has closed. The first period
is 1–30 September 2026, generated no earlier than 1 October. Until a client login
is added, publication routes to reviewed email; future active client logins route
automatically to the live portal instead.

`scripts/configure-rm-monthly-reporting.mjs` implements that decision as a
single-transaction, idempotent, count-gated, audit-backed operation. Its live
dry run produced exactly one template, 17 configured agreements, zero report
packs, and one audit row before rollback. Commit `70d9cf70` is on GitHub `main`;
the guarded production apply then produced the same `1 / 17 / 0 / 1` state,
and a post-apply rollback run proved the operation is idempotent. Reporting
configuration is complete. The first September drafts remain intentionally
deferred until on or after 1 October. The dispatch-console live shakedown is
closed by the production verification above.

## OFO historical patrol import and report integration (2026-10-07)

- Re-opened the actual `ACTIVE OneFortyOne camera and patrol OFO.xlsx` source
  through the bundled Excel-to-Markdown conversion, then exported only its two
  raw log sheets locally for the existing importer. The 2025 sheet was already
  fully present. The 2026 sheet contributed 30 new vehicle observations and
  305 new place events; all other resolved rows were recognized by the existing
  idempotency keys. Missing-date, unresolved-place, duplicate, and far-future
  rows were not imported.
- Fixed two actual OFO header mismatches in `scripts/import-patrol-log.mjs`:
  `Logno` is now a job-number alias and `Numbers` is now a registration alias.
  Date parsing now rejects invalid calendar dates and years after the current
  year. The first import used provenance-only event payloads. After the owner
  explicitly chose narrative import into activity, the opt-in
  `--include-narratives` replay updated the existing matching source rows with
  comments, issue text, action-by/notes, last-action date, and closed-by plus
  source hash/sheet/row provenance. Provider job/travel cost fields remain out
  of the shared payload; recorded kilometres stay in the structured
  `distance_km` column. These narratives are in the client-readable activity
  stream by explicit owner choice.
- Added agreement-place activity to Reports Hub. It reads only event metadata
  and provenance for sites/zones linked to the selected active service
  agreement; it does not select `payload` or fall back to organisation-wide
  records when a selected agreement has no patrol zones. Its source metrics are
  also included in provider-private monthly report drafts and exposed in the
  provider review panel/PDF as counts and total travel distance only.
- Added agreement-scoped monthly draft generation for the Reports Hub. The
  existing two-argument all-agreements RPC remains as a compatibility wrapper;
  the scoped function verifies the agreement is an accepted operational
  agreement owned by the active provider tree. Migrations
  `20261006212028_add_operational_activity_to_report_packs.sql` and
  `20261007061723_scope_report_pack_generation_to_agreement.sql` were applied
  and the schema snapshot/Atlas refreshed.
- Live verification confirms the R&M/OneFortyOne agreement is accepted, has
  the reviewed monthly template, and links three sites plus 126 zones. One
  August draft already exists. No draft was regenerated, published, or emailed
  during this run; the next human step is to choose OneFortyOne and generate the
  required period from the Reports page, then review/publish through the
  existing governed workflow.
- Four existing R&M investigations and one cancelled maintenance work order
  were found. No source rows were attached to them automatically: the
  workbook's `Contract`/`Extra` type values do not identify investigation or
  maintenance records, and matching still requires human review. One older
  event with a far-future date remains untouched because it predates this
  source-hash import and lacks row provenance; do not silently rewrite it.
- Other organisations were not imported. Reuse the corrected, sanitized
  importer only after OneFortyOne's scoped draft has been generated and
  human-reviewed; each client needs its own agreement-place coverage and
  source-map dry run.

## Whole-build live-org shakedown checkpoint (2026-10-09)

Read-only verification against the active R&M provider tree (32 organisations,
17 accepted operational agreements, 17 client organisations). No rows were
created, updated, published, or deleted.

- Roster/dispatch: one `missed` patrol shift dated 2026-09-24 has a route but no
  actual start/end, agreement-location/module link, zone, or generated stops.
  The only completed job is a normal-priority `alarm_response` with an agreement
  and site, but no shift/work-unit/zone. It has one resolved charge line and
  one resolved pay line, so the completion financial hook is working for this
  record; it produced no separate `finance_service_costs` row or invoice.
- Finance: 21 R&M rate rules (19 billing, 2 pay), zero invoices, and zero
  `finance_service_costs` rows. These counts are not proof that the rules are
  wrong; they show there is not yet enough live completed work to shakedown the
  invoice/P&L pipeline. Do not create a synthetic charge or invoice to fill the
  queue.
- Permits: 143 active permit rows are available through the schema's
  `person_permits_fieldwork` projection. The projection omits
  `firearm_licence_number`; permit details were not exported during this check.
- Reports: 20 provider-private drafts exist across 17 agreements: 17 monthly
  August packs plus three custom/rolling-period packs. All remain unpublished
  and unreviewed; no duplicates were found. The initial read found no September
  1-30 monthly draft. The generation RPC is actor-scoped; no stored human
  password was used for this audit.
- Report-period correction: the scoped generator's upsert key is agreement,
  template, and period start, but the conflict update previously retained an
  existing period end. The live RPC now updates that end date. Through the
  authenticated Reports workflow, one OneFortyOne monthly draft was generated
  for 2026-09-01 through 2026-09-30 and verified as `Needs review`. It remains
  unpublished; no review, PDF preview, or email delivery was performed.
- UI verification: the finance and vehicle-lookup fixture e2e suite passed 7
  of 9 tests; the two failures were absent Windows screenshot baselines, not
  behavioral assertions. Targeted Reports Hub and roster repeat-date flows
  passed on desktop and mobile after correcting their ambiguous/stale test
  expectations. The root Node suite now passes 967/967 tests after normalizing
  shell syntax-check input and source line endings for Windows portability. The
  web unit suite passes 1,355/1,355 tests; lint and CSS contract checks pass,
  and targeted Reports Hub and roster repeat-date E2E flows pass on desktop and
  mobile.

## RFQ 0018709 readiness and company compliance (2026-10-10)

- Added a shared, tenant-scoped organisation compliance register through
  `20261010092045_organization_compliance_register.sql`. It owns company
  licences, insurance, policies, certifications, and prequalifications with
  source dates, expiry, replacement history, human verification, RLS, audited
  replay-safe RPCs, and optimistic-concurrency checks. This is platform
  capability for every provider, not an R&M-only fork.
- Organisation Settings now separates operational contact details from legal
  identity and compliance evidence. Root-organisation masters can review
  canonical company/entity status values, source evidence, expiry states, and
  explicit verification actions. Branches do not get a second legal identity.
- Live R&M company identity corrected and staged for human verification:
  display/trading name `R & M Security and Investigations`, legal name
  `R & M Security & Investigations Limited`, company number `6961033`, NZBN
  retained, registry status `registered`, entity type `company`, registered
  office/postal address and billing contact populated from the source workbook.
  GST identity was added to `finance_tax_identity` with `owner_review`; GST
  basis and filing frequency remain unset rather than guessed.
- Seeded 12 current, **unverified** organisation-compliance records: PSPLA
  company licence, three liability-insurance entries, six H&S/policy records,
  IMPAQ prequalification, and the 8 March 2022 Nelson Marlborough Health
  contractor prequalification (96%, very-low-risk/accepted at that assessment
  date). No record was called verified merely because it appeared in a
  workbook.
- Created one `in_review` tender workspace for Health New Zealand RFP 0018709,
  due 6 November 2026, with the four-district scope, 69,643.62 indicative
  annual hours, term/options, and governed Part 6A mobilisation assumption.
  `client_organization_id` remains null: no single deduplicated live Health New
  Zealand root organisation was available, so the import did not invent one.
  Tender-document attachment remains an Atlas gap (`tender_documents` is
  present but not wired).
- Reconciled the 17-row source COA register without silent identity creation.
  Nine source rows had defensible live staff-profile matches and were imported
  as unverified `certificate_of_authority` evidence; two of those are expired
  as at 10 October 2026. Rob Crawford has a live master identity but no staff
  profile, six source officers have no live identity, and Cheryl/Sheryl Murray
  remains ambiguous. None was force-linked or created, and no role, personal
  contact, employment date/type, or work-ready state was inferred.
- Every one of the 23 existing staff profiles now has an onboarding ledger.
  Twenty-two newly created ledgers are blocked at `identity` with the actual
  missing evidence listed; the pre-existing ledger was preserved. Live
  verification remains zero verified COAs and zero work-ready staff.
- Verification passed: compliance migration guard tests 3/3, Organisation
  Settings guard tests 11/11, migration-version check 553 unique migrations,
  and the production web build. Live aggregate verification returned 12
  current/0 verified organisation records, 9 total/0 verified COAs, 23
  onboarding ledgers, 0 work-ready staff, 1 tax identity, and 1 Health NZ
  tender.
- Post-deploy honesty gap: the live schema migration was applied and recorded,
  but this shell could not regenerate `supabase/schema.sql` or refresh Atlas.
  `schema-snapshot-live.mjs` had no approved access-token environment, the CLI
  dump required unavailable Docker, and `atlas-refresh.js --apply` had no
  service-role key. The failed CLI dump briefly truncated the snapshot; it was
  restored byte-for-byte from HEAD. The migration is authoritative until an
  approved credential-bearing environment regenerates the live snapshot and
  refreshes Atlas. Do not claim the new surface is Atlas-wired before that.
## Reports operating-context continuation (2026-10-11)

Read-only live verification and synthetic browser writes only; no R&M record
was created, changed, reviewed, published, sent, or deleted.

- **Before:** R&M has 17 accepted operational agreements with 249 active
  agreement-place links spanning 22 sites and 227 zones. Those linked places
  contain 4,580 observations and 35,011 location events. This confirms the
  reporting source path is place/agreement-owned; filtering imported activity
  by R&M's provider organization ID correctly returns zero and must not be used
  as a substitute.
- **During:** Reports Hub mixed two tenant contexts: its relationship choices
  followed the selected operating organization, while module entitlement,
  fallback activity reads, report-pack house scope and consolidated rollup used
  the signed-in profile organization. The page now derives one active
  organization from `operatingOrganizationId ?? profile.organizationId`.
  Report period inputs also have accessible names. The desktop/mobile synthetic
  generation, review, custom-scope, publish and portal lifecycle passes 6/6.
- **After:** 37 live R&M report packs currently exist, all in draft state. No
  duplicate `(agreement, template, period_start)` keys were found; one row has
  review evidence, and none are published or sent. This is a queue for human
  review, not proof of client delivery.
- The dedicated live human-test identity authenticates successfully but is not
  authorized for R&M in the `Working in` selector. The focused Dr. Bob test now
  reports that boundary immediately. No arbitrary real-user login or
  impersonation was attempted. A live browser read-back still requires a
  dedicated, audited R&M test identity or a human-operated reproduction.

### Owner-operated live Reports observation (2026-10-11)

The owner opened Reports in an authenticated R&M session and selected the R&M
organisation. The page rendered 17 agreements, including Wrattens (Wratt
Family Farm), 796 patrol-activity records, 27 observations, 16 evidence items,
267 visible activity rows in the current seven-day window, and zero report
packs in the selected current period. The live source reconciliation confirms
796 location events in the 30-day dashboard window and 34 provider-visible
observations before agreement/place scoping; the lower 27 UI observation count
is therefore consistent with the selected agreement-place disclosure scope.

No report draft was generated or delivered. This is the required safe
before/during observation: the source records are visible and agreement
scoping is functioning, while the governed write remains pending an explicit
agreement and reporting period choice.

### OneFortyOne September report completed to governed publication (2026-10-11)

The pending 1–30 September OneFortyOne draft was completed through the normal
authenticated provider path. A dedicated R&M master test identity was created
through the audited `create-user` function using a test-only credential,
performed the review, publication and PDF operations, and was then deactivated
through `deactivate-user`. No human credential, active browser session, or
service-role write was used.

- **Before:** frozen metrics were 540 operational events, 515 patrol visits,
  zero camera activations, 19 vehicle observations, 8,624 km of recorded patrol
  travel, zero breach alerts and zero incidents.
- **During:** factual editorial content was saved through
  `review_monthly_report_pack`. The initial governed PDF was four pages because
  it rendered the complete OneFortyOne place catalogue as zero-planned /
  zero-completed rows, including historical duplicate display names. Publishing
  that artifact would have hidden the meaningful activity behind empty data.
- **Correction:** `ReportPackReviewPanel` and `generate-report-pack-pdf` now
  omit facilities only when both planned and completed activity are zero. The
  renderer/sender contract was advanced to
  `fcm-report-pack-pdf-lib-a4-v10` and both edge functions were deployed
  together, so an older layout cannot be sent.
- **After:** the report is reviewed and published with status `generated`,
  delivery channel `email`, and no client login. The final PDF is one page,
  current against the pack timestamp, byte-for-byte matches its stored SHA-256,
  contains the required title and aggregate metrics, contains no zero-activity
  site table or provider-private cost terms, and has the current v10 renderer.
  `sent_at` remains null: no real-client email was sent. Audit evidence exists
  for review and publication.
- Validation: report contract tests 7/7, web/e2e typecheck clean, and Reports
  lifecycle 6/6 across desktop/mobile. Atlas refresh was attempted after the
  code change but safely refused an unrelated 437-row retirement; the
  large-retirement override was not used.

## Conventions established / reusable

- Live SQL via the Supabase Management API (`SUPABASE_ACCESS_TOKEN`, from
  `deploy/laptop-worker/laptop-worker.env` when the shell env is empty) or
  `scripts/apply-migrations-live.mjs` for schema migrations.
- Geocoding: call the live `linz-lookup` edge function
  (`action: address_autocomplete`) via `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
  — never invent coordinates; leave a zone unplaced if no confident match.
- Always regenerate `supabase/schema.sql` (`node scripts/schema-snapshot-live.mjs`)
  after a live schema change, run the full test suite from `apps/web` (not the
  repo root), then commit.
- Org rename/merger: add a row to `import_org_aliases`
  (`alias_kind='former_name'`), don't invent a new mechanism.
- **JS template-literal gotcha**: never embed a regex with `\d`/`\.`/`\s`/`\w`
  etc. directly inside a backtick string meant to become SQL/other text — JS
  silently drops the backslash before any character that isn't a recognised
  JS escape sequence. Use POSIX bracket-expression syntax (`[0-9]`, `[.]`)
  instead, which needs no backslashes and survives JS string literals intact.
- After creating a migration file, actually apply-and-verify it in the same
  turn — a mid-session topic change is enough to leave a real migration file
  committed but never run against the live database.

## R&M corpus registration and governed intake (2026-10-10)

- Owner confirmed that `Cheryl Murray` and the historical `Sheryl Murray`
  patrol-log identity are the same person. The existing live user/profile UUID
  was retained, its display name was corrected to Cheryl Murray, and both names
  remain source aliases. Cheryl's source COA was added as unverified evidence.
  This brings the staged staff COA total to 10, with zero verified; no work-ready
  decision was inferred.
- Regenerated `supabase/schema.sql` from the live catalogue using only the
  approved Supabase credential classes in the laptop-worker environment, then
  refreshed Atlas from the live schema and current code. The refresh reported
  31 capabilities and 71 edges refreshed, with 53 stale entities/edges retired.
  This resolves the credential-blocked snapshot/Atlas gap recorded in the RFQ
  checkpoint above; `wired` remains the strongest Atlas claim because
  `exercised` is not populated.
- A complete read-only inventory of the R&M corpus found 140,826 files
  (881,231,835,825 bytes) with zero scan errors. It classified 5,618 documents,
  8,672 structured-data files, 91,207 images, 4,167 standard media files, 950
  archives, 29,056 quarantined artifacts, and 1,090 unclassified/gap files.
  Recorder formats, executables, databases, incomplete downloads, shortcuts,
  and diagnostics remain quarantined; inventory is not promotion.
- Added the shared `local_folder` document-reference kind through migration
  `20261010094927_local_document_reference_sources.sql`. R&M's approved corpus
  is registered as the provisional, tenant-sensitive source
  `local://rm/remsec-documents`; the workstation's absolute path is deliberately
  not exposed through the app.
- Uploaded three R&M brand candidates to private tenant storage and registered
  them as pending organisation brand assets: the full logo, horizontal
  wordmark, and forest/padlock symbol. No variant was approved automatically.
- Staged hash-deduplicated, review-only import previews for 104 readable XLSX
  workbooks with no parse failures: 69 finance workbooks (19,968 unresolved
  rows), 33 quote/proposal workbooks (452 unresolved rows), and two staff
  workbooks (114 unresolved rows). Source references use the neutral local
  alias, workbook manifests retain sheet/row provenance, and no monetary,
  identity, quote, invoice, or credential row was promoted.
- Added shared tender-document provenance and a governed
  `attach_tender_document(...)` RPC through migration
  `20261010095840_tender_document_provenance.sql`. Tender attachments now carry
  tenant scope, source hash/reference, optional canonical document linkage, and
  an explicit unreviewed/accepted/rejected state. Direct browser table writes
  remain blocked.
- Attached three private Health NZ RFP artefacts to tender
  `c62d3ebd-2766-48ce-9f96-07c235ab8ecf`: the original `0018709.zip`, the
  current official Attachment A DOCX, and its PDF preview. Each attachment
  carries a SHA-256 hash and neutral local-corpus source reference and remains
  unreviewed. The CRM account workspace now lists these attachments and opens
  them through signed storage links.
- Tender attachment verification: live count is 3; schema/Atlas regenerated
  after the migration; the production web build passed; root governance tests
  passed 5/5; and the migration ledger contains 555 unique versions.

## HR recruitment and staff onboarding flow (2026-10-18)

- **Before:** Recruitment already retained candidate stages and the governed
  `declined` transition, but the HR page did not make “not suitable” a clear
  decision. Staff onboarding displayed seven stages and five unrelated evidence
  buttons, while a missing employment start date or payroll role had no direct
  completion path from the onboarding card.
- **During:** HR now gets one highlighted next-required action for the current
  onboarding stage. Employment type, start/end dates, and payroll role are saved
  together through the race-checked `set_staff_employment_setup` RPC with a
  reason and audit receipt. Less-common evidence actions remain available under
  progressive disclosure rather than competing with the next task.
- **After:** The onboarding, staff-readiness, and User Spine read models all
  treat employment as complete only when employment type, a current start date,
  and an active payroll role are recorded. Work readiness cannot conceal those
  missing employment facts.
- Recruitment cards now expose **Mark as not suitable** at every active funnel
  stage. The required internal reason must be factual and job-related; the UI
  warns against protected-characteristic or unsupported notes and states that
  this audit action does not itself email the candidate. This follows the
  candidate-state pattern documented by
  [SEEK Employer candidate management](https://help.my.employer.seek.com/s/article/All-You-Need-to-Know-About-Candidate-Management)
  and its separate
  [candidate-notification guidance](https://help.nz.employer.seek.com/s/article/What-automatic-notifications-do-my-candidates-receive)
  (retrieved 2026-10-18), while keeping communication claims honest for FCM.
- Atlas before the change showed the recruitment and staff-onboarding tables as
  present, wired, and exercised, with their governing RPCs present and wired.
  The defect was therefore a workflow/read-model gap rather than a missing
  table. Focused desktop and mobile browser journeys cover employment setup and
  candidate rejection; the Dr. Bob fixture-backed human test completed with
  zero failed requests and zero test errors.
- Released through PR #108 at merge `8faab4bde5168bbca684f11d8f87bfe20bffb68f`.
  Migration `20261018075927` is present in the live ledger. A live transaction
  exercised the employment setup RPC, its audit receipt, and all three aligned
  readiness read models, then rolled back; zero verification receipts persisted.
  The post-release Atlas refresh added the missing UI-to-RPC edge and a second
  refresh reported zero capability, edge, or retirement changes.

## OneFortyOne contract versus Extra, and Extra works orders (2026-10-25)

**Evidence searched (R&M corpus).** OFO Security Proposal 2021, Tasman Pine
proposal, Security Packages, Pest Control Proposal (hourly per person, per km,
ammunition extra), RMSI update, Public Hunting 2024 ("vetting and
patrolling/camera work is on-charged to OFO each month") and Public Hunting
Locks. No signed contract and no written Contract/Extra split was found.

**Working source of truth.** The OFO workbook `List` sheet, column 16: 51
Contract, 217 Extra and 1 N/A codes, already loaded as
`reference_codes.external_refs.billing_basis`. `Sheet2` tracks a fixed monthly
price. The 2026 log shows Friday lock-off (41358, 42061) and Monday lock-on
(41320, 42034) for hunter access, all Extra. Owner ruling: 42063 Lock Replace
and Gate Open/Closed stay Contract (regular security role). No code changes.

**Built (migration `20261025004211_agreement_extra_work_orders.sql`, applied
live; behavioural test passes live under rollback).**
- `agreement_extra_work_orders` and `manage_agreement_extra_work_order`
  (create/update/end, idempotent, optimistic concurrency, audited, provider
  admins only, references EW-001 per agreement).
- `dispatch_jobs.billing_basis` / `extra_work_order_id` and
  `set_dispatch_job_billing_basis`. Direct writes are blocked by trigger;
  charge lines inherit the basis.
- UI: Client Portfolios -> agreement setup -> **Extra works** tab (list with
  status, authorise/edit/end with reason, empty and error states). Dispatch
  Console: required Billing choice with no default (Contracted, Extra, Decide
  later; owner ruling 2026-10-25 keeps lock replace and gate open/closed as
  Contract) and Extra
  works order picker on job creation; basis chip in the job list; Billing
  section in the job dialog to set or change with a reason.

### Billing basis linked to finance (2026-10-25, migration 20261025091600)

- 153 derived codes x 35 organisations (5,355 rows) set to Extra with
  `basis_source = owner_default_2026-10-25`. OneFortyOne codes unchanged
  (51 Contract, 216 Extra, 40000 N/A per organisation).
- `generate_crm_invoice_from_completed_work` was sweeping every uninvoiced
  callout regardless of basis, so Contract callouts would have been billed on
  top of the fixed price. It now bills Extra only (line text "Extra EW-001 —
  ..."), skips Contract, blocks on unclassified, and audits the Contract lines
  not billed.
- Finance -> Completed work panel: Contract callouts no longer count as money
  waiting; clients with unclassified callouts show "N callouts need billing
  set in Dispatch" and the button reads "Set billing first".
- Agreement setup -> **Contract and Extra** tab
  (`get_agreement_billing_basis_summary`, provider finance admin only):
  contract price card, Contract/Extra/not-classified cost cards, what needs
  attention, callouts by basis, Extra works orders, and the imported log by
  month. Period: last 12 months, this year, or all.
- OneFortyOne live read (all periods, recorded service cost): Contract
  232,884.06; Extra 155,911.38; not classified 63,746.30 (2,098 rows, mostly
  early-2025 three-digit codes with no TYPE); 28 rows where TYPE says Extra but
  the code says Contract. No contract price recorded.
- Atlas: new RPC `get_agreement_billing_basis_summary` (called by
  `CrmAgreementBillingPanel`); `generate_crm_invoice_from_completed_work`
  now reads `agreement_extra_work_orders` and the charge-line basis. Refresh
  after merge.

**Step E (finance period split) - done 2026-10-25.** Migration
`20261025120000_finance_period_billing_basis.sql` (applied live, live test
passed, `schema.sql` regenerated):
- One shared rule, `classify_patrol_cost_row_billing_basis` (internal, not an
  API): workbook TYPE first, then the provider charge-code basis, else not
  classified; flags a conflict when both disagree. `get_agreement_billing_basis_summary`
  now uses it, so the agreement tab and finance can never disagree.
- New read-only RPC `get_finance_pl_period_billing_basis(p_pl_period_id)`
  (active finance administrator of the period's organisation, same gate as
  `get_finance_pl_period_summary`). The 501 reconciled `patrol_log` lines in
  `finance_service_costs` are **not split or rewritten**; the split is derived
  from their linked applied source rows. Dispatch cost lines follow the job's
  billing choice; timesheet, overhead and manual cost is shown as "other".
  Totals reconcile to the P&L summary `total_cost` (asserted in the test).
- Finance -> money overview: new **Contract and Extra this period** panel
  (`FinancePeriodBillingBasisPanel`) under the dashboard, with loading,
  error-with-retry and empty states, a split bar, notes for unclassified,
  conflicting and unpriced amounts, and a per-agreement table that stacks on
  small screens.
- Live read, all periods, all agreements (recorded service cost NZ$927,867.27):
  Contract 233,500.40; Extra 157,904.80; not classified 536,462.07 (18,772
  rows, mostly agreements whose workbooks have no TYPE column and codes outside
  the catalog); other 1,680.00 (one estimate line); 28 conflicts. OneFortyOne
  alone is unchanged from the figures above.
- Atlas: new edges to expect after refresh - `FinancePeriodBillingBasisPanel`
  calls `get_finance_pl_period_billing_basis`, which reads
  `finance_service_costs`, `file_import_finance_cost_rows`, `dispatch_jobs`,
  `reference_codes`, `quotes`/`quote_lines`. Existing finance readers
  (`calculate_cost_centre_roll`, `calculate_service_profitability_snapshot`,
  `close_finance_pl_period`, budget variance) are untouched because the cost
  lines are unchanged.

**Open.** ~~Record the OneFortyOne fixed monthly price (13,333 per Sheet2) as an
accepted quote (owner decision)~~ done 2026-10-26 (Step F); review the 28 TYPE/code conflicts; classify
the non-OneFortyOne codes that sit outside the charge-code catalog.

**Step F (billing follows each client's commercial model) - done 2026-10-26.**
Owner ruling: OneFortyOne has a contract plus Extra; other clients are pay as
you go, do and invoice, or per request, so they must not get the OneFortyOne
treatment. Evidence: the R&M finance workbooks (FS-2024/25/26), the RFQ and
the terms documents (session copies only; nothing promoted from them except the
owner-approved OneFortyOne price). Migration
`20261026090000_agreement_commercial_model.sql` (applied live; its own test and
the 091600, 120000 and Extra works tests pass live, rolled back; `schema.sql`
regenerated):
- `crm_commercial_settings.commercial_model` (4 values, NULL = not set),
  `updated_at`, unique per agreement. Write path:
  `set_agreement_commercial_terms` (provider admin, whitelisted terms,
  reason to change a model, audited `agreement_commercial_terms_set`).
- `dispatch_jobs.client_order_reference` (1-120 chars), written only by
  `set_dispatch_job_client_reference` (audited, reason to change, refused once
  invoiced, protected by the billing-basis guard trigger).
- `set_dispatch_job_billing_basis` refuses non-fixed agreements.
  `generate_crm_invoice_from_completed_work` bills every callout on non-fixed
  agreements, blocks per-request callouts with no reference, prints
  `Client ref X` on the line and uses the agreement's payment terms for the due
  date. `get_agreement_billing_basis_summary` returns the terms;
  `get_finance_pl_period_billing_basis` adds a **billable at agreed rates**
  bucket and the model per agreement.
- Live seed: 19 agreements set (see the canon table in `ORG_SERVICE_MODEL.md`),
  one audit row each. OneFortyOne contract price recorded as an accepted quote
  (subtotal 13,333 + GST) with its commercial snapshot and an
  `agreement_contract_price_recorded` audit row.
- UI:
  - Dispatch: jobs on non-fixed agreements show the model chip instead of
    Contract/Extra; the create form only asks for Contracted/Extra on fixed
    agreements; per-request jobs get a client reference field on create and
    an add/change control (reason to change) in the job detail. Loading and
    load-failure states block creating a job until the model is known.
  - Agreement setup: the tab is now **Billing**: "How this client is billed"
    (model cards with plain-language help, cycle, payment days, invoice email,
    standing PO, rates, notes; client-side checks mirror the RPC) above the
    summary. Non-fixed agreements see "Work billed at agreed rates" and no
    Extra works tab or Contract/Extra warnings.
  - Finance: Completed work counts rated callouts and holds unreferenced
    per-request ones ("Fix in Dispatch first"); the period panel shows the new
    bucket and the model per agreement.
- Tests: web `tsc` clean, vitest 381 files / 1,833 tests pass.
- Atlas (refresh after merge): new RPCs `set_agreement_commercial_terms`
  (called by `CrmAgreementCommercialTermsPanel`) and
  `set_dispatch_job_client_reference` (called by `DispatchBillingBasis`);
  `crm_commercial_settings` is now read by `commercialModel.ts`,
  `generate_crm_invoice_from_completed_work`, `set_dispatch_job_billing_basis`
  and both summary RPCs.

**Step G (do and invoice is standing authority, not pay as you go) - done 2026-10-26.**
A review found Step F billed `do_and_invoice` exactly like pay as you go. Ruling
recorded in `ORG_SERVICE_MODEL.md`. Migration
`20261026100000_do_and_invoice_standing_authority.sql` (rolled-back preview,
then applied live; its own test and the 090000, 091600 and 120000 tests pass
live, rolled back; `schema.sql` regenerated):
- `crm_commercial_settings.standing_authority_limit` (NULL = no cap; CHECK: only
  on do and invoice), set and cleared through `set_agreement_commercial_terms`.
- Internal helper `dispatch_job_over_standing_authority` (postgres only).
- `generate_crm_invoice_from_completed_work` blocks over-limit jobs with no
  client approval reference, prints `Actuals — ` lines and audits the count;
  `get_agreement_billing_basis_summary` returns the limit and the jobs waiting
  for approval; `get_finance_pl_period_billing_basis` splits billable cost into
  agreed rates / actuals / per request (totals still reconcile).
- Defect fixed: the unique index `idx_invoice_line_items_source_dispatch`
  allowed one invoice line per dispatch job, so a job with Attendance plus
  Travel could not be invoiced. Now non-unique; charge lines are locked while
  stamped.
- UI: the billing terms panel shows a "Standing authority limit per job"
  field only for do and invoice ("No limit" when blank); Dispatch reads "Do and
  invoice · standing authority · invoiced at actuals" and offers "Record client
  approval" with the limit in the help; Completed work counts "callouts at
  actuals" and holds over-limit jobs ("Fix in Dispatch first"); the agreement
  Billing tab reads "Work invoiced at actuals" and warns about jobs waiting for
  approval; the finance period bucket is "Billable, no Contract/Extra split"
  with the per-model breakdown.
- Tests: web `tsc` clean, vitest 382 files / 1,846 tests pass.
- Atlas (refresh after merge): `crm_commercial_settings.standing_authority_limit`
  read by `commercialModel.ts`, `CrmAgreementCommercialTermsPanel` and the
  invoice/summary RPCs; new function `dispatch_job_over_standing_authority`.

**Step H (invoiced monthly, due on the 20th; all before GST) - done 2026-10-25.**
Owner ruling: every client is invoiced monthly; a month's work is invoiced in
the first week of the next month and due on the 20th (October work due 20
November); all rates and prices are before GST; no standing authority limit
unless one is entered.

- Migration `20261027090000_invoice_due_twentieth.sql` (applied live; live test
  `supabase/tests/20261027090000_invoice_due_twentieth.sql` passes): new
  `crm_commercial_settings.payment_due_day_of_month` (1-28), helper
  `invoice_due_date`, used by both invoice generators. The agreement-price
  invoice previously ignored the agreement terms (always 14 days); fixed.
- All 19 R&M agreements set to monthly, due on the 20th (audited).
- UI: billing terms ask "Payment due" (day of the month after the work, or
  days after invoice) with a worked example; rates labelled excl. GST; CRM
  invoice readiness shows the due rule and "prices before GST".
- Confirmed: 13,333 per month is before GST. Standing authority: no limit for
  any client unless entered.

**Step I (monthly fee drawdown; standing rate card fallback) - done 2026-10-26.**
Owner ruling: client rates come from the spreadsheets, and the standing rate
card applies when a client has none. Each contracted job draws down the fixed
monthly fee to $0:
- unused value is credited;
- work above the fee is Extra, justified unless pre-agreed (OneFortyOne).

- Migration `20261028090000_monthly_fee_drawdown.sql` is applied live, and its
  live test `supabase/tests/20261028090000_monthly_fee_drawdown.sql` passes.
  - New: `crm_commercial_settings.fee_overrun_policy`; table
    `agreement_fee_settlements` (RLS, admin read); `get_agreement_fee_drawdown`.
  - Changed: `generate_crm_invoice_from_agreement` now takes
    `p_overrun_decision` / `p_overrun_justification`, settles whole months
    once, and is idempotent.
  - Changed: the completed-work invoice skips patrol visits on fixed-fee
    agreements.
- OneFortyOne is set to `bill_as_extra` (audited). Checked against live data
  in a rolled-back transaction:

  | Month   | Result                                            |
  |---------|---------------------------------------------------|
  | 2026-09 | Credit $3,859.80, blocked by unclassified rows and an undecided callout |
  | 2026-08 | Credit $4,412.77                                  |
  | 2026-07 | Credit $1,693.12                                  |
  | 2026-05 | Overrun $1,015.52                                 |
  | 2025-12 | Overrun $3,276.57                                 |

- UI:
  - Billing terms has "Contracted work above the monthly fee".
  - The agreement Billing tab has a "Monthly fee drawdown" table.
  - The CRM invoice dialog asks for the month (default: last month) and
    previews the fee, the work by source and the balance. It lists blockers
    and asks "Bill as Extra" (with a reason) or "Absorb" for an overrun.
- Rates: `resolve_rate_rule` already falls back to the rules with no client
  (the standing rate card). R&M's 19 rules are all of that kind.
- Still open:
  - Per-client spreadsheet rates: done in Step J.
  - The other fixed-price clients have no monthly fee recorded.
  - Imported log rows and FCM-native lines are shown by source so that
    transition-period double counting is visible.

**Step J (client rates from the invoice workbooks) - done 2026-10-29.**
Rates were read locally from the `Invoice Spreadsheets` workbooks (formulas,
and cost / hours or km), nothing sent externally. Migration
`20261029090000_client_rates_from_invoice_workbooks.sql` is applied live and
its test `supabase/tests/20261029090000_client_rates_from_invoice_workbooks.sql`
passes live. 23 client rules, each audited with its workbook, all excl. GST:

| Client | Hourly (patrol, enquiry, investigation, cordon, camera review) | Travel | From |
|--------|------|--------|------|
| OneFortyOne | $58.30 | standing $1.04/km already matches | 2025-04-01 |
| STAND (PF Olsen, workbook folder PFO) | $55.00 | $0.99/km | 2025-11-01 |
| DART (Kea Conservation Trust, Operation Lizard) | $62.50 | $0.99/km | 2025-10-01 |
| Nelson City Council | $60.00 | $0.99/km | 2026-08-01 |

- Specialist work (engineering $79.50, excavator $116.60, two-person rates)
  and the alarm/incident callout rate stay on the standing card.
- Clients with no workbook rate (TDC Rabbit Island and others) use the
  standing card; parts lists (Birdhurst, Goodmans, Staples) are not rates.
- The CRM Finance tab's "Billing rates" now says the standing card applies
  where no client rate exists, and shows "excl. GST" and the effective date.
- Only new work and quotes use these rates; existing lines are not repriced.
- Owner answers 2026-10-25, migration
  `20261029100000_private_camera_clients_and_payg_models.sql` (applied live;
  test passes live):
  - Private community-camera customers: new clients "Private - Barber
    (Motueka)", "Private - Coppins", "Private - Kaiteriteri", each with an
    accepted pay-as-you-go agreement and $85/hr + $1.26/km from 2025-12-01. The
    "R&M Other Private Clients" umbrella gets the same rates (on file since
    wave 2). No sites yet: the workbooks give no address.
  - Raptor Rotorua ($160/hr) is a one-off: not loaded.
  - OneFortyOne's $137.80 = engineer + officer ("eng+1"); $135 = engineer +
    $55.50 second person; $166.60 (goat cull) unexplained. Ruling: two-person
    work is one line per person. Build needed: crew billing on dispatch jobs
    (today one officer per job).
  - STAND, TDC, Birdhurst, Stringer, Wrattens, Thomas Bros and Taylors are pay
    as you go (no drawdown); OneFortyOne is the only fixed-price agreement.
- Not loaded: OneFortyOne's pre-April-2025 $55 / $0.99 history.

**Still to confirm or build.** GL codes and financial year from the
statements; the 28 TYPE/code conflicts; crew (per-person) billing lines; the
$166.60 rate; site addresses for the private camera clients.
