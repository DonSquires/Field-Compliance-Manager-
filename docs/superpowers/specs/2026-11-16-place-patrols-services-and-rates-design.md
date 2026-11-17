# Place patrols, services and rates: design

Date: 2026-11-16. Status: approved 2026-11-16 (see Owner decisions).

## Intent

An administrator must be able to open a place (for example Rabbit Island
(TDC)), and set up everything that is delivered there, all in one spot:

- which patrol work unit covers the place
- when it patrols
- what the officer checks on each visit
- which specialty service applies
- whether a static guard is posted
- what the client is charged

Today this setup is spread across three CRM screens. None of them reaches
sunrise/sunset windows, random days or visit checks. The Operational setup
also refuses places that are areas (zones) rather than addressed sites, so the
work cannot be finished from the place.

The client is charged from what was agreed and what was proven on the ground
(GPS presence, completed visits). The schedule and rates therefore have to stay
the client agreement's terms, even though they are edited from the place.

## Owner decisions (2026-11-16)

1. The schedule and the rates are the client agreement's terms, edited from
   the place. When a term changes on a live agreement, the change is recorded
   as a dated version with an effective-from date. The earlier version is never
   overwritten.
2. A site and a zone are equal. A site has an address; a zone is an area of
   land with no address, or with several. An officer patrolling either is
   doing the same work. Nothing may require a Site when a zone will do.
3. The work happens in a new **Patrols & services** tab, and later a
   **Finance** tab, inside the existing Operational setup
   (`apps/web/src/components/OperationalPlaceManager.tsx`). This was my
   recommendation, and the owner did not object. It replaces separate CRM
   pages and adds no new page.
4. Any change to a live agreement's schedule or rates is a dated version. A
   second administrator's approval is an optional organisation setting (see
   call 0).
5. Who may set up static posts is an optional organisation setting (see
   call 2).

Status: approved by the owner on 2026-11-16, with decisions 4 and 5 amended.

## Goals

The project has three parts. They are built in this order, each with its own
plan and pull request.

### Part A: Patrols & services (this document's detailed scope)

A1. **Place parity.** The Site briefing tab becomes the **Briefing** tab. It
works for any site or zone of the place.

- Zones gain the same briefing fields that sites have: risk level, what
  happens here, access, health and safety.
- The static-post briefing check reads the zone briefing when the post is a
  zone.
- The message "No Site is linked to this place" is removed.

A2. **Patrols & services tab.** The tab lists every service delivered at the
place, across all of its sites and zones. Each service is shown as a row card
with:

- the specialty service
- the place anchor (which site or zone)
- the work unit
- a schedule summary
- the checks
- the effective-from date

Actions: Add patrol, Add static guarding, Edit, End (an end date, never a
delete).

A3. **Patrol schedule editor.** The editor has these fields:

- Place anchor: a site or zone of this place.
- Specialty service: from the active module catalogue, restricted to services
  delivered as visits.
- Patrol work unit: an existing patrol work unit of the operating branch, or
  "create one". The work unit is the responsible patrol run from #537
  (`patrol_config_responsibilities`).
- Days: either
  - fixed days of the week, or
  - **random**: N days per week drawn from the allowed days.
- Time window, one of:
  - any time
  - fixed `hh:mm–hh:mm`, which may cross midnight
  - **sunrise/sunset**: a start and an end, each anchored to sunrise, sunset
    or a clock time, with a ± offset in hours (0.25-hour steps)
- Months: all, or chosen months. Seasons are shortcuts that tick months
  (Summer = Dec–Feb and so on). Seasons are not stored separately.
- Visits per shift, minimum gap, time on site: the existing fields.
- Checks: multi-select from the check-type catalogue (A6).
- Officer instructions.
- Effective from: defaults to today. A future date is allowed.

A4. **Static guarding.** "Add static guarding" asks for:

- the place anchor
- the post name
- the operating branch
- required skills (optional)
- effective from

It creates the agreement module and the place link if they are missing. It
then creates a rostering work unit of type static, linked to the agreement
location and the `static_guarding` module, through the existing
`create_operating_roster_work_unit`. The unit appears on the roster
immediately and gets no visit schedule; the post's hours come from the roster.

A5. **Through the agreement, with versions.**

- The tab resolves the client's live operational agreement for this place. If
  there is more than one, the user picks. If there is none, the tab explains
  this and links to create one; it never invents an agreement.
- Every save runs through one new place-centred RPC. It reuses the
  validation, idempotency and audit of `manage_crm_agreement_delivery_schedule`,
  and supports both sites and zones.
- Each change writes an immutable version row:
  - schedule id
  - effective from
  - full terms as JSON
  - actor
  - reason
  - client request id
- The live columns on `service_agreement_delivery_schedules` and
  `client_site_patrol_config` show the version in force today.
- The stop generator reads the terms in force on the shift date. This follows
  the effective-dated pattern #537 used for `patrol_config_route_at`.
- Preview, then submit for approval (decision 4). The preview shows:
  - shifts already generated that would change
  - the next four weeks of patrol days (including the random draw) and
    windows, to administrators only

A6. **Check types are data.** A catalogue table, `patrol_check_types`, holds
global defaults plus organisation-specific additions. Each check type has:

- a key and a label
- whether it needs a photo or a note
- whether it is active

It is seeded with:

- lock-up
- unlock
- random check
- bed-down
- welfare check
- gate check
- key pickup
- key return

How checks flow through:

- The schedule stores its required check keys.
- The generator copies them onto each stop.
- The officer's stop screen lists them.
- Each check is recorded as a `shift_stop_action`, with `action_type` set to
  the check key, a GPS fix and an outcome.
- A required photo uses the private original-photo evidence path, registered
  to the exact stop, officer and shift. It remains unverified and pending
  privacy review; a supplied filename alone is not evidence.

A stop with required checks is complete only when every check is recorded or
explicitly marked "could not complete" with a reason. Without the officer side
the checks would be dead data, so the officer side is part of Part A.

A7. **Sunrise and sunset.**

- They are computed in the database by an immutable solar function (the NOAA
  algorithm), using the anchor's centre point and the Pacific/Auckland zone.
- The centre point is the site's `center_point`, or the zone's `center_point`,
  or the centroid of its boundary.
- If an anchor has no coordinates, a sunrise/sunset schedule cannot be saved.
  The user is told to draw the boundary first.

A8. **Random days.**

- The days are chosen per ISO week, deterministically from a per-schedule
  secret seed and the week number.
- The seed is stored server-side and never sent to officers, clients or the
  public.
- The draw is unpredictable to the public but reproducible for an audit:
  anyone authorised can show why a day was or was not patrolled.
- When the terms change, the draw changes only from the effective date.

### Part B: place finance rates (outline; detailed design after Part A)

A **Finance** tab in the same Operational setup, building on the #537 billing
selection (`location_client_billing_selection`, `patrol_billing_units`):

- Three rate lines:
  - patrol
  - static
  - response
- Each line has a source:
  - the agreement's standard rate
  - per hour
  - fixed amount
- If a place has no charge rate, the user can create one inline. It is written
  as a site- or zone-scoped `rate_rules` row.
- Hourly patrol and static time is charged on GPS-qualified on-site time, as
  decided in #537.
- Response is charged as an initial attendance block (default 0.5 h), then
  further time in increments (default 0.5 h), rounded up. Both values are
  editable and stored on the rate, not hard-coded.

### Part C: remove duplicate CRM pages (after A and B)

1. Inventory every place where patrol schedules or place rates are edited
   today:
   - `ClientSetupPage`
   - `CrmOperationalWorkPanel`
   - `CrmAccountWorkspace`
   - any others found
2. Replace each editor with a read-only summary and an "Edit at the place"
   link.
3. Remove the dead code and routes.

Nothing is removed until its replacement is live.

## Non-goals

- A new invoice engine. Part B feeds the existing billing selection and the
  invoice flow from #537.
- Rostering static posts from this tab. The roster stays the place where
  shifts are made.
- Public or client-portal views of patrol days.

## Anti-goals

These would count as failure even if the feature works technically:

- A schedule or rate that changes what the client is charged without a dated
  record of who changed it and from when.
- A patrol day the public can predict, or one the operator cannot explain
  afterwards.
- Check lists or season definitions hard-coded in the UI.
- A screen that saves fields the generator or the officer never uses.
- Any flow that still demands a Site where a zone exists.

## Constraints

- Canon: agreements hold commercial and delivery authority
  (`docs/canon/UNIFIED_FIELD_OPERATIONS_MODEL.md`, #537 records). The place
  is the anchor. Module-as-data.
- `client_site_patrol_config` has fixed check constraints:
  - `module_key` takes a fixed list of 11 values
  - `time_window_type` takes fixed, sunrise_sunset, seasonal or as_attended
  - the place XOR (exactly one of site and zone)
- The new window and random fields must extend these constraints, not bypass
  them.
- `manage_crm_agreement_delivery_schedule` rejects `static_guarding` on
  purpose. Static guarding stays a work unit, not a visit schedule.
- Security:
  - every new SECURITY DEFINER RPC checks `auth.uid()` and the provider admin
    check
  - EXECUTE is revoked from PUBLIC and anon
  - the seed column is not readable through the Data API
- Migrations are tested on a disposable PostgreSQL (the CI pattern). The
  baseline uses fixtures, not `schema.sql` function bodies, because a later
  catalog refresh would break that.

## Approaches considered

1. **A tab inside Operational setup, saving through the agreement.** Chosen.
   One place to work, no new page, and it reuses the #537 responsibility and
   billing backend.
2. **A separate service-schedule page per place.** Quicker, but it adds a
   page, which is the opposite of the owner's request to reduce duplicate
   pages.
3. **Move the CRM agreement panel into the place as it is.** Least new code,
   but the panel is shaped around the account, and it lacks sunrise/sunset,
   random days and checks, so it would need rebuilding anyway.

## Calls made during review (owner to check)

0. **Second approval is an organisation setting** (owner decision 4, as
   amended). "Changes to live agreements need a second approver" is stored as
   data per provider organisation, not hard-coded. It is **off by default**,
   because some organisations have only one manager.
   - **When it is off:** saving applies the change as a dated version from its
     effective date. It records who made the change and when, and it appears
     in the agreement history.
   - **When it is on:** the rules below apply to adding, editing and ending
     any schedule, static post or rate on a live agreement.
   - Saving creates a *pending* version. The place card shows "Waiting for
     approval" with the proposed differences, and the item also appears in the
     existing Approvals activity page (`ApprovalsActivityPage`). No new
     approvals screen is added.
   - The approver must be a different user who passes the existing
     `can_approve_action` check for the agreement's provider organisation. The
     requester can never approve their own change.
   - The approver sees the same preview and can approve or reject it with a
     reason. On approval, the version becomes effective and the generator uses
     it from its date.
   - A change never takes effect before it is approved. If the effective-from
     date has passed by the time of approval, it takes effect on the approval
     date, and the preview says so.
   - A static post's work unit is created only on approval.
   - Rejected and pending versions stay on record.
   - If the setting is on but no other eligible approver exists, the screen
     says so and offers to turn the setting off (which is itself recorded). It
     never auto-approves.
1. **The random draw filters stops; it does not roster shifts.** People still
   roster the patrol run on the roster. On the shift date, the generator
   includes this place only if the date is a drawn day.
   - The coverage preview shows a warning when a drawn day in the next four
     weeks has no rostered shift for the responsible unit.
   - Rostering staff never see which days were drawn.
2. **Who may set up static guarding is an organisation setting** (owner,
   2026-11-16: the owner may be on leave).
   - By default, only administrators of the agreement holder can set up and
     operate static posts, which is today's rule in
     `create_operating_roster_work_unit`.
   - The agreement holder can turn on "Branches may set up static posts".
     Administrators of its descendant branches can then create, operate and
     end static posts on its agreements. This uses the same descendant-branch
     rule that patrol schedules already use.
   - The setting is data. Turning it on or off is audited.
   - The shared function is changed to honour the setting, not relaxed for
     everyone.
3. **Static posts have no effective-from date.**
   - Adding a post creates the work unit at once.
   - End sets the unit inactive. Existing rostered shifts are kept; new shifts
     are refused.
   - Both actions write an audit row and a version row with their dates.
4. **Organisation check types have a small admin list.** "Manage check types"
   on the Patrols & services tab lets an administrator add, rename or
   deactivate their own organisation's types. The global defaults are
   read-only.

## Left to the builder

- Exact table and column names. Whether the version store is one table or
  sits on the schedule.
- How to split the RPCs, as long as each save is atomic and idempotent.
- The visual detail of the tab. It must follow
  `docs/BOB_ENTERPRISE_SAAS_UX_TRAINING.md`, covering loading, empty, error,
  permission, success and preview states.
- The officer check list on mobile and web stop screens, in the existing stop
  component style.
