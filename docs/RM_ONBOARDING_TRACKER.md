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
- **Real cross-cutting finding (whole-build shakedown): `organizations.name`
  has no uniqueness constraint, and demo/E2E test fixtures are not visually
  distinguished from real seeded clients.** Discovered while starting the
  Phase 2 NCC import: THREE separate organization rows are all named exactly
  "Nelson City Council" —
  - `405fc1f7-45e8-4736-a517-885bb3e5ef95` — the REAL one, R&M's wave-1 seed
    (`organization_type='government'`, 4 real geocoded zones, 1 accepted
    operational agreement). **Use this id for all NCC patrol-log import work.**
  - `fc4ca1c9-e606-4a93-b21b-da79274c7440` — pre-existing E2E test fixture
    (created 2026-08-27, before this effort started). Has a
    `finance-e2e-client@field-compliance.test` `client_viewer` user profile
    (matches this repo's established `*@field-compliance.test` fixture
    convention, e.g. `scripts/seed-aam-e2e.js`), 2 client_sites, 1
    freedom_camping zone, 3 service_agreements — all synthetic demo content,
    zero connection to R&M.
  - `7171d3c7-f820-483b-ba2d-122fe067b8a8` — a `status='prospect'` CRM lead
    (created 2026-09-06, also before this effort), 3 client_sites (Miller
    Acre — duplicated in the E2E org too, Nelson Public Library, Tahunanui
    Beach). Also unrelated to R&M's real relationship.
  Neither duplicate was created by this session's seed work, and no data has
  been lost — R&M's real org is fully intact and correctly separate. But an
  admin searching "Nelson" in CRM/org pickers today sees 3 confusing rows,
  two of which are meaningless test/demo debris. **Not fixed yet** — a safe
  fix (e.g. renaming the two non-R&M rows to something unambiguous like
  "Nelson City Council (E2E Fixture)") needs to first confirm no e2e script
  matches-by-exact-name to decide whether to (re)create its fixture, or a
  rename could cause a 4th duplicate on the next test run. Flagging for
  owner decision rather than guessing at a live rename. **Action for anyone
  continuing this work: before seeding or importing against ANY client name,
  check `select id, name, organization_type, status, created_at from
  organizations where lower(name) = lower('<client>')` first — do not assume
  a name match found by the seed script's own dedup logic is the only row
  that exists.**
  Confirmed the SAME pattern for TDC: a second, unrelated "Tasman District
  Council" org exists with `parent_organization_id IS NULL` (not checked
  further — no observations/location_events touch it, and R&M's real
  `54ade19f-0bb7-45ca-a32d-2d87214c4e77` correctly received all of wave 5's
  new zones, confirming this is systemic across the platform's demo data
  rather than a one-off NCC quirk). Expect to find this again for other
  government/council-style client names as more clients are onboarded.

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
3. **STAND's "Borlace Forest" zone** has no confident geocode yet — created
   unplaced; needs a better reference point (e.g. from a company map or a
   council LINZ parcel search) before it can be placed.
4. **Run the Phase 2 importer against the remaining ~12 clients** (STAND,
   M&R, Taylors, Birdhurst, Thomas Bros, Stringer, Fulton Hogan, DART, PVT,
   Private-Parks, Private-Redvale-Merc) — proven against DOC, NCC, AND TDC
   now (three clients, three different raw-sheet conventions, the importer
   generalized cleanly each time via header-candidate lists rather than
   per-client forks). Each client needs its own zone-name-to-zone-id map
   built from its actual Location/Reserve/CODE/Forest column values (same
   process used for DOC/NCC/TDC: export full raw sheet to CSV, count distinct
   location values, cross-check the client's own List/reference sheet before
   geocoding, geocode any new real places, build the map, dry-run, apply).
   For any client with a large multi-year log (thousands of rows), the
   importer's batching (chunks of 300) already handles the request-size
   limit — no further script change needed there. More officer names will
   likely surface — add them as real `user_profiles` the same way (role
   'officer' unless told otherwise), and check whether a name already has a
   profile under R&M's org before creating a duplicate (Don Squires already
   did). Before seeding zones for any client, also run the duplicate-org
   check (`select id, name, organization_type, parent_organization_id from
   organizations where lower(name) = lower('<client>')`) — both NCC and TDC
   turned out to have unrelated pre-existing orgs sharing their exact name.
5. **Whole-build live-org shakedown** (the other half of this task): with
   real, populated org data now flowing all the way through to
   `search_observations` and `location_events`, walk through the remaining
   operational surfaces a real R&M admin/officer would use — CRM account
   view, dispatch, rostering, finance/invoicing, permit lookup — and fix
   anything that breaks or looks wrong against real data. Record findings
   here as they're found.

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
