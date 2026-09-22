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

## Open items (not yet done)

1. **Wrattens** (Wratt family farm, code WRAT) — deliberately deferred. Raw
   comments contain an active third-party trespass dispute (named individuals,
   phone numbers, a recorded phone-call transcript). Needs the same
   locked-base-table + redacted-view security treatment already used for
   `firearm_licence_number` before this client's data is imported, not a
   simple "just seed it" pass.
2. **TDC has ~74 more reserves** in its own reference list beyond the 2
   geocoded so far (Rabbit Island, Appleby Recreation Reserve) — geocode more
   as real patrol activity against them is found, not preemptively.
3. **STAND's "Borlace Forest" zone** has no confident geocode yet — created
   unplaced; needs a better reference point (e.g. from a company map or a
   council LINZ parcel search) before it can be placed.
4. **Run the Phase 2 importer against the remaining ~15 clients** (NCC, TDC,
   STAND, M&R, Taylors, Birdhurst, Thomas Bros, Stringer, Fulton Hogan, DART,
   PVT, Private-Parks, Private-Redvale-Merc) — proven against DOC only so far.
   Each client needs its own zone-name-to-zone-id map built from its actual
   Location/Reserve/Forest column values (same process used for DOC: export
   full raw sheet to CSV, count distinct location values, geocode any new
   real places, build the map, dry-run, apply). More officer names will
   likely surface — add them as real `user_profiles` the same way (role
   'officer' unless told otherwise), don't block waiting to catalogue every
   name first.
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
