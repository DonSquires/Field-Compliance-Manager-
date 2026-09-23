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

1. **Wrattens** (Wratt family farm, code WRAT) — deliberately deferred. Raw
   comments contain an active third-party trespass dispute (named individuals,
   phone numbers, a recorded phone-call transcript). Needs the same
   locked-base-table + redacted-view security treatment already used for
   `firearm_licence_number` before this client's data is imported, not a
   simple "just seed it" pass.
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
6. **DART's "Update 251215" sheet (539 rows) was not imported this pass** —
   it uses a different, header-less layout with a blanket "DART" code and no
   per-row header row (unlike the main `2025`/`2026` sheets, which needed the
   real header row found ~265 rows down past a leading charge-code reference
   table, then trimmed before the importer could run). Worth a follow-up pass
   once the higher-value clients are done.

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
- Still open: Cycle Trails (TPFL, 276 rows), MPC pest-control log (TPFL, 173
  rows, attribute to Pete/Rob Crawford), Digger work order (OFO, 1 row,
  ready via the now zone-capable Workshop RPC), OFO Culling Log 2023
  (~23 rows).

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
