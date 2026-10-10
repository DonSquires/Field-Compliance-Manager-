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
