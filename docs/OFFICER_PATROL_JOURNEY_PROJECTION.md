# Officer patrol journey projection

Local migration contract; not deployed or live-verified.

`get_officer_patrol_journey(p_shift_id uuid)` returns JSON or `null` for an
unavailable assignment. It independently checks the active caller, officer
role, exact assignment, consistent operating-organisation records, `published`,
`accepted` or `in_progress` status and a scheduled end strictly in the future.
It does not call or secure the older `get_officer_patrol_stops` RPC, which
still returns unreviewed narrative and permits historical reads.

Shape:

```
{
  shift_id, patrol_id, checkpoint_requirement: "route" | "site_zone",
  route_geometry: null, route_geometry_status: "unavailable",
  stops: [{
    id, stop_order, visit_number, status,
    place: {kind: "site" | "zone" | "unknown", site_id, zone_id, name,
            address, coordinates: null | {lat, lng, source: "site_center" | "zone_center"}},
    clients: [{id, name}], client_attribution_complete: boolean
  }],
  checkpoints: [{
    id, kind: "route" | "site", name, required, sequence_order,
    site_id, zone_id, stop_ids: [uuid], visited,
    auto_geofence_status: "verified" | "unverified" |
      "missing_or_invalid_geofence" | "unavailable_route"
  }]
}
```

Stops are the existing contracted non-adhoc, non-static plan, ordered by
`stop_order`, `visit_number`, then ID. Coordinates are stored place centres,
not a road route or verified attendance; absent points remain null. No stored
route geometry has been proven. Do not join the points into a claimed driven
or navigable route or transmit them to an external map service without an
authorised path. The response omits instructions, descriptions, safety notes,
visit notes and other unreviewed free text.

Clients are distinct contextual recipients of valid, mutually consistent
stop-module, agreement-module and agreement-location links at the exact
place, with an operational agreement covering the shift date and its provider
or branch. No place-owner fallback is used. Missing or inconsistent links
yield an incomplete attribution flag; an empty client array does not prove
there is no client. Multiple linked clients may legitimately occur.
If a malformed stop has both a site and a zone, the site is the primary
place: its missing coordinates stay null and an agreement for only the zone
does not establish that site's client attribution.

`required` follows `complete_patrol_session`: when there are active mandatory
route checkpoints these alone are required; otherwise every active checkpoint
matching the shift zone or **any** stop is required, including ad-hoc/static
stops. Active non-mandatory route checkpoints and, in route mode, matched
site/zone checkpoints are optional. Route checkpoints have no site/zone
association. A site checkpoint can match multiple stop IDs or only the shift
zone; neither implies completion of a particular stop. `visited` reflects the
selected in-progress session only and is false if there is none.
`auto_geofence_status` describes configuration only, not whether the current
fix, stop or session permits automatic recording. Route checkpoints have no
visual verification state and are never auto-eligible.

An inconsistent stop/route organisation raises an operations-review error.
The existing completion function considers cross-organisation matching
site/zone checkpoints, while the visit writer rejects them. In fallback mode
the projection raises an operations-review error instead of disclosing those
identities or presenting an incomplete list. This does **not** fix that
existing completion/writer inconsistency. The checkpoint set can change while
the officer works; re-read it and treat completion as authoritative.

## Sanitized stop actions projection

`get_officer_patrol_stops_sanitized(p_shift_id uuid)` returns `null` for an
unavailable assignment, otherwise the legacy `{shift, stops}` operational
shape. It independently checks active identity, officer/admin role, exact
assigned shift and consistent operating-organisation records, eligible status, and non-overdue
end. It wraps the legacy RPC and allow-lists stop order, statuses, times,
attendance/travel facts, required checks and module facts. Site/zone name and
address remain structured operational identifiers. It returns `route_name`,
`officer_instructions`, `officer_notes`, place `access_instructions`,
place `hs_notes` and check `notes` as null. It does not return other newly
added legacy fields automatically. Check `label` is the `check_key`, not the
unreviewed configurable label; checks and outcomes are retained, so an
uncompleted check never becomes an empty checklist.

**Residual disclosure:** custom `check_key` values are derived from configurable
labels and may themselves encode unreviewed content. The key is currently
required by the existing check writer, and place names and addresses are also
unreviewed structured text. This wrapper therefore does not establish a
complete privacy boundary. The original `get_officer_patrol_stops` RPC and
other legacy paths can expose raw narratives. A separate local migration
restricts the raw reader's API grants, but that restriction is not deployed;
its release and dependent callers must be verified. Do not silently fall back
to raw paths. Withholding required checks in a future redesign
must block completion rather than falsely reporting no outstanding checks.

## Automatic checkpoint capture

`auto_record_patrol_checkpoints(p_shift_id uuid, p_gps_lat double precision,
p_gps_lng double precision, p_gps_accuracy double precision,
p_captured_at timestamptz)` returns
`{status: "processed" | "no_session", patrol_id, shift_id, recorded_checkpoint_ids: [uuid], checkpoints:
[{checkpoint_id, kind, site_id?, zone_id?, status}]}`. It independently
requires an active officer/admin identity, exact assigned in-progress session
and in-progress shift. Capture may continue after the planned end while that
owned duty and session remain in progress. The shift operating organisation need not
equal the officer's profile home organisation. A valid assigned active shift with no in-progress
session returns `no_session`, a null `patrol_id` and empty arrays without
recording anything. Multiple matching in-progress sessions fail closed.

Fixes must be finite and in range, accuracy greater than zero and at most
50 metres, and captured no earlier than shift/session start, within 30 seconds
of server time and at most five seconds in the future. The fix must still be
fresh after locks are obtained and when each new visit is written. Position and
capture time are client-supplied; this is not spoof-proof location evidence.

Active assigned site/zone checkpoints require a valid point and radius,
`checkpoint_verification = 'verified'`, a recorded verifier and verification
time no later than the fix, and `server distance + reported accuracy <= radius`.
Status is `recorded`, `already_recorded`, `unverified`,
`not_verified_at_capture`, `missing_or_invalid_geofence`, `accuracy_too_low`,
`outside_geofence`, `boundary_uncertain`, or `recorded_unattributed`.
Missing or ambiguous planned-stop matches are recorded
with null stop attribution and audited as `missing` or `ambiguous`, not refused.
Active route checkpoints are returned as
`route_not_eligible`, never auto-recorded: they have no P2 verification state.
`already_recorded` only means a visit already exists for the session; it
does not certify that older visit or a later repeated stop.

The existing session writer records at most one visit per checkpoint per
patrol. Automatic capture therefore leaves the stop unresolved when zero or
multiple pending, en-route or on-scene stops match, audits the resolution, and never
claims a new visit for a repeat. It does not record site arrival or departure,
change the stop's attendance state, or replace those separate actions. A
shift-zone checkpoint with no matching open stop may be recorded without stop
attribution. Overlapping checkpoints can each be recorded
from one fix if its entire uncertainty circle fits each verified geofence;
this is not evidence of separate journeys between checkpoints. Each newly
created visit gets a verification snapshot and a separate auto-capture audit
event alongside the checkpoint-recorded audit in the same transaction. Automatic
capture inserts its narrowly scoped visit directly, rather than calling the
manual writer, whose cross-branch overdue restriction remains. Eligibility is
the owned shift's `in_progress` status, not its scheduled end: an officer still
on duty after `scheduled_end` keeps automatic capture, and the result exposes no
place or note narrative. The RPC serializes with itself and the existing
session writer. The auto RPC locks stops before the shift and uses nonblocking
locks with a retry error for contention: departure locks a stop before updating
the shift, while other workflows use the opposite order. The session writer
and completion lock the shift before the patrol; the manual writer also takes
nonblocking matching-stop locks and leaves ambiguous open-stop attribution null,
with `stop_resolution: ambiguous` in its audit metadata.
Auto-capture never waits on the shift while holding stop locks. Other legacy/raw
visit paths may have different concurrency and verification semantics. This
change does not repair or revoke those paths.

## Assigned operating-branch sessions

The separate operating-branch migration preserves the existing signatures of
`start_patrol_session(p_shift_id uuid)`,
`record_patrol_checkpoint_visit(p_patrol_id uuid, p_checkpoint_kind text,
p_checkpoint_id uuid, p_gps_lat double precision, p_gps_lng double precision,
p_gps_accuracy double precision, p_notes text default null)`, and
`complete_patrol_session(p_patrol_id uuid, p_notes text default null)`. A
live exact shift assignment permits a different profile home organisation.
The session officer and organisation must match the assigned officer and
shift operating organisation; inconsistent active sessions, route or stops
fail closed. New patrols, visits and audit events use the operating
organisation. Cross-branch use requires a non-overdue shift in `published`,
`accepted` or `in_progress`; manual checkpoint capture additionally requires
`in_progress` duty and preserves ambiguous visits without guessing a stop.
Manual visits snapshot the site's verification state (route anchors are explicitly
unverified); presence at an unverified anchor is labelled visited, not verified.
Session and visit receipts suppress `notes` in
that newly enabled case. Same-branch receipt behaviour is retained. The manual
checkpoint writer's pre-existing GPS semantics are not the conservative
automatic-verification policy.

## Cross-branch read projections and remaining gates

`get_assigned_officer_shift_context()` returns an array of the active caller's
exact assignments in `published`, `accepted`, or `in_progress`, with future
end and start no later than 24 hours ahead, plus overdue in-progress recovery.
Items with `context_status: available` have `id`,
`organization_id`, `officer_user_id`, `service_type`, `scheduled_start`,
`scheduled_end`, `status`, `location_id`, `zone_id`, `patrol_route_id`,
`created_at`, `updated_at`, and ordered `shift_stops` containing IDs, order
and arrival/departure times. Route/zone names, site names and agreement/module
context are null, not inferred. An overdue assignment returns only identity,
organisation, actor, status and timing with `context_status: recovery_only`.
An inconsistent stop or route organisation returns the same minimal fields
with `context_status: requires_review`, without discarding other valid
assignments. These limited rows disclose no place or narrative.
`useActiveShift` supplements its existing RLS-visible reads with this
projection; it preserves visible overdue in-progress shifts for recovery without
waiting for the new RPC, and otherwise reports an error if that RPC is
unavailable. `PatrolPage` also
supplements its existing today/overnight shift list with these assignments.

`get_assigned_patrol_session(p_shift_id uuid)` returns null for an unavailable
assignment or `{shift_id, session, visits}`; `session` is null or
`{id,status,started_at,ended_at}`, and each visit has
`{id,checkpoint_id,route_checkpoint_id,visited_at,scan_method,notes:null,
within_radius,checkpoint_verification_at_visit}`. It requires the caller's
non-overdue active assignment, exact session actor/organisation and consistent
visit/checkpoint scope; inconsistent records fail rather than disappearing.
Visit notes are withheld even for the same branch. The Patrol page uses it
instead of direct patrol and visit SELECTs.

No RLS was broadened. **Cross-branch end-to-end operation is not established**:
`OfficerSchedulePage` still directly SELECTs shifts under `accessible_org_ids()`,
so an officer lacking branch reach may not find or start the shift there.
The supplementary context deliberately cannot establish an agreement module;
`ServiceRelationshipContext` therefore reports active-shift location context
unavailable rather than assuming one. Other raw-table reads and module gates
remain subject to RLS/entitlements.

Safety and stop actions are separate release gates, not silently waived.
`get_shift_safety_briefing` permits the assigned officer without a profile-home
match, but its hazard/warning narrative is not covered by this projection's
privacy review and its legacy reader has no non-overdue/active-profile check.
`acknowledge_safety_briefing` checks the assigned officer and open status and
writes the shift organisation; neither path has been cross-branch field-tested.
The `shift_stops_require_safety_briefing` trigger requires the matching current
briefing hash before arrival when risks exist. `record_patrol_stop_check`
requires an active profile, owned in-progress shift and on-scene stop;
`manage_officer_patrol_stop` checks owned in-progress shift. Both write in the
shift organisation but their existing functions do not independently enforce
the new readers' non-overdue and stop-organisation consistency checks.
Do not treat their existence as complete cross-branch authorization or safety
acceptance. Arrival/departure, check recording, schedule/start, safety briefing
privacy and branch module context require separate governed verification.

The officer shell reuses its existing location watch for the active in-progress
shift, requests a fresh fix when the patrol session is opened or connectivity
returns, and refreshes the patrol receipt after newly recorded or previously
recorded visits are observed. Failed, stale or inaccurate fixes are not queued
as evidence; the officer sees a warning and may retry. Lock contention triggers
a fresh-fix retry while the portal remains open. The browser may suspend or stop location updates in the
background. Device reliability, field acceptance and actual presence remain
unproven.

Release still requires governed migration application, catalog/schema
regeneration, Atlas refresh after deployment, and human-operated acceptance.
### Atlas and schema preflight

The read-only capability lookup found `shifts`, `patrols`, and
`patrol_checkpoint_visits` present and wired; it did not find `useActiveShift`
or these local, undeployed RPCs. The table rows reported `exercised=true` for
`shifts` and `patrols` and null for visits, contrary to the earlier unpopulated
expectation; no invocation evidence was verified, so none is claimed exercised.
Across the three tables and the hook, direct live edges counted 165 reads,
33 writes, 11 secured-by, 6 references, 6 triggers and 79 FK references.
Those are combined counts, not a proof of hook coverage or individual paths.
Flow reach and FK reach are separately **unknown**: read-only CLI attempts
were denied execute permission, after earlier attempts timed out. The latest
Atlas refresh recorded source `fdf3b0ccb7e1b01d2ca70c3b272ccd84388880c0`,
matching `origin/main`, not this undeployed worktree.

Schema and code confirm that `shifts`, `patrols`, and
`patrol_checkpoint_visits` SELECT policies depend on `accessible_org_ids()`;
`useActiveShift`, `PatrolPage`, and `OfficerSchedulePage` read shifts directly,
while the page previously read patrols and visits directly. The shared hook
also drives home, shell and module location contexts. This is cross-module
terrain: retest assigned branches, unchanged overdue recovery, safety context,
session/visit refresh, schedule navigation and stop actions with dedicated
identities after governed deployment. The smallest next check is a human
reproduction with an assigned officer whose operating branch is absent from
their RLS reach; no live writes were performed here.

### Local review verification

The integrated officer suite passed 110 desktop/mobile browser checks, including
patrol, static guarding, roster, recovery and dispatch handoff. The responsive
patrol check covers widths from 320 to 2560 pixels; a subsequent desktop/mobile
hit-test confirmed that the account overlay stays above the open Leaflet map.
Focused web tests passed 52 cases, disposable PostgreSQL tests passed 22 cases,
mobile contracts passed 13 cases and private briefing handlers passed 21 cases.
Web, E2E and mobile TypeScript checks and migration-version checks passed.
The final unresolved-attribution SQL adjustment separately passed all 12
auto-capture test cases.

Failed refreshes retain existing stop forms and drafts with an error, rather
than hiding them. Partial private briefings offer retry; review outages withhold
text without introducing an arrival-evidence gate. Existing server-enforced
hazard acknowledgements remain unchanged.

The repository-wide CSS contract check still reports exactly the same selector
mismatches on unchanged branch HEAD; none names the patrol files. These are
local synthetic checks, not deployment, live invocation or human field evidence.
