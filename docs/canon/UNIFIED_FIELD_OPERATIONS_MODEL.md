> **Canonical copy (extract).** Origin: GitLab `don-squires1/field-compliance-manager` `docs/ARCHITECTURE.md` @ `Main`, read 2026-09-14 via `scripts/gitlab-read.mjs`. Only the still-canonical sections are kept: the Refining Layer (unified field-operations model), the NZ Legal Framework, and the Key Design Principles. The System/Bob/RunPod/Railway infrastructure sections of the origin were already marked SUPERSEDED there and are omitted; current infrastructure is in `docs/INFRASTRUCTURE_VERIFICATION_MAP.md`. The "Live status" section at the end was verified against the live database on 2026-09-14.

# Unified Field-Operations Model

## Refining Layer — Unified Field-Operations Model

> Status: design authority for the field-operations refinement. Records decisions
> worked out 2026-07-11/12. This is the "next level" refinement over L1-L4, not a
> new foundation. Detail sections marked DEFERRED / RESEARCH are not yet decided.

### The unifying truth

**Every field role is a guard on a place for a shift, with a toolset.** Everything
else is configuration.

- **Freedom camping** = a guard on a ZONE + the FC scan tool.
- **Parking** = a guard on a zone + the parking scan tool.
- **Noise / smoke / biosecurity** = a guard on a place + that assessment tool.
- **Static guarding** = a guard on a site with the base toolkit only (no specialty tool).
- **Patrol** = a guard covering MANY places in one shift (a multi-stop assignment).

The "guard-ness" is identical across all of them; the specialty tool is the only
delta. No module is a bespoke build — each is "add a tool" on the one spine.

### Three-gate tool resolution

Which tools a guard can use in a shift is the intersection of three gates:

1. **Person eligible** — the guard holds/qualifies for the tool (`user_profiles.module_access` = eligibility).
2. **Place capability** — the site/zone is configured for the tool (`organization_modules` / place config). The place dictates what is POSSIBLE.
3. **Assignment grant** — the roster grants the guard the tools required for THIS shift. The roster dictates what is ACTIVE.

Effective toolset = person-eligible ∩ place-capability ∩ assignment-grant, **plus the
base toolkit which is always on**.

### Assignment (the bucket)

An **assignment** is the bucket that carries a client's requirement + places into a
shift. It is a STANDING operational unit the roster STAFFS (not created per shift).

- **Parent assignment** = the client requirement / operational unit. Holds settings:
  `guards_required`, schedule (dates or recurring), and **type** (see below).
  Carries the **base call sign** (e.g. "Alpha").
- **Child assignments** = the individual staffable positions under the parent
  (collapsible children). Each child has its OWN tool selection and supervisor
  options, and sequences its call sign from the parent (Alpha 1, Alpha 2, ...).
  "3 guards required" = a parent with 3 children.
- **stops** = the places (site XOR zone). Static = 1 stop; patrol = N stops.
  Pre-planned (from roster) or ad-hoc (from dispatch).

**Assignment type** (does double duty):
- **Dispatch routing** — general patrol / client patrol / specialty patrol / static —
  so dispatch can identify who to send a job to.
- **Channel grouping** — a type (esp. general patrol) may opt into a shared base call
  sign / group channel (e.g. 4 Nelson patrol runs sharing a "Nelson Patrol" channel).

### Staffing lifecycle (roster)

The assignment bucket flows through the roster into ownership:

1. Assignment (bucket) exists holding client requirements.
2. Rosterer places the bucket in the roster for specific dates or on a schedule.
3. Staffing mode:
   - **Direct assign** — attach a specific guard -> guard is notified -> **confirm**
     (owns it for the shift/sequence) or **decline**.
   - **Open** — all QUALIFIED guards (hold the required tools) are notified -> guards
     **put their name forward** -> rosterer **selects + approves** one.
4. On confirm/approve, the guard **owns the bucket** for the shift or sequence.

States: `unstaffed -> offered (direct|open) -> owned`, plus decline/withdraw.

### Presence

Proof the guard is (was) at the place: shift start/end + verification-point /
checkpoint scans + GPS. Identical mechanism for static (one long stop) and patrol
(many stops). Feeds SLA/obligation, timesheets, welfare, and client "your site was
serviced" reporting. Presence records carry `client_org_id` (same tenancy substrate
as compliance observations).

### Base toolkit (shared, always on)

Every guard, every module, has the same first-class, evidence-anchored field-report
tools, each anchored to shift + stop + place + GPS + officer + time:

- incident report
- health & safety report
- maintenance report
- suspicious vehicle
- suspicious person
- verification point (site round proof)
- photo / short video evidence

Suspicious vehicle / person can **promote** into canonical entity intelligence
(VOI / POI / LOI flags) — the seam into the vehicle-compliance family.

> **Owner ruling 2026-09-16 — provisional CCTV person profiles.** CCTV inference
> creates or reuses a canonical profile for each credible face/body portfolio.
> An unidentified profile is named `Unknown Person #N` within the operating
> organisation and carries its source observations, embeddings and provenance.
> This is a growing profile, not verified identity: it remains
> `manual_review_required` until a human reviews the footage and names or merges
> the existing profile. A model never asserts a known name, marks a profile
> verified, or creates an enforcement consequence.

> **Owner ruling 2026-10-11 — human-authored operational records are
> observations.** A person or vehicle mentioned in a report, patrol log,
> incident entry, suspicion record, or issued trespass notice is a valid
> observation because a human recorded what they saw, received, or issued. It
> does not require a second human verification step before entering the
> observation and evidence spines. Explicit source identifiers such as a stated
> name, registration plate, notice recipient, source job number, date, place,
> and author may create or link the corresponding tenant projection and
> canonical entity with full provenance. This ruling does not turn an
> allegation into a proved fact, infer an unstated identity, merge ambiguous
> people, or authorize an enforcement consequence: observation type, source
> wording, confidence, allegation/status, and notice state must remain distinct.

### Specialty tools (plug-ins)

Activated by place-capability ∩ assignment-grant. Two verdict styles + static:

- **Vehicle compliance** (FC, parking) — subject is a plate; ALPR identity; verdict
  = time/place rule (nights / overstay / SCV); enforcement = infringement / NTV /
  tow. Two-observation patterns (FC overnight, parking chalk return-verify).
- **RMA / environmental** (noise, smoke, biosecurity) — subject is a place/activity;
  verdict = measurement/matrix + escalation ladder; enforcement = direction /
  abatement / seizure notices.
- **Static** — no specialty tool; base toolkit only.

Compliance specialty tools produce **observation -> verdict -> breach -> enforcement
ladder** on the shared substrate (`observations`, `breach_alerts`, `notices_to_vacate`,
`infringement_notices`, `enforcement_cases`, immutable `enforcement_case_events`,
atomic counters). **Freedom Camping is the reference build for the vehicle style**
(see the FC compliance redesign epic + `docs/FREEDOM_CAMPING_IMPLEMENTATION_BLUEPRINT.md`).

### PTT — call-sign hierarchy (channel topology DEFERRED)

Call-sign tree mirrors the assignment tree:

```
[optional group channel]   e.g. "Nelson Patrol" (type = general patrol)
  +- parent assignment     base call sign "Alpha" -> channel
       +- child Alpha 1     (guard position)
       +- child Alpha 2     (guard position)
```

Parent dictates the channel; children share it as Alpha 1 / Alpha 2. The channel
ROUTING / monitoring / emergency-broadcast topology is DEFERRED to the PTT design —
it derives from this tree but must express child -> parent -> optional type-group,
supervisor cross-assignment monitoring, and SOS cross-assignment broadcast.

### Ad-hoc dispatch — OPEN / RESEARCH

Reactive path (needs more research before build):

- Job in -> dispatch selects existing site/zone OR creates one via the onboarding
  wizard (place may not exist yet — links the rapid ad-hoc site-create work).
- Dispatch selects the reason (noise, alarm, FC, ...) -> a **response template**
  pre-populates the job with the required tools + legal basis + SLA.
- Routed to the correct assignment by **type**; becomes an **ad-hoc stop** on that
  assignment (or spawns a one-stop assignment when none is nearby).
- The template is the **tool-grant authority for the ad-hoc job** (grants a tool the
  guard was not pre-granted). Open questions: ad-hoc-stop vs spawn-assignment;
  type enum vs capability-derived; fast site/zone create-on-the-fly.

### Naming reconciliation

- **`patrol_routes` -> `assignments`** — the current name leaks "patrol" (movement/
  sequence/patrol-module) but the concept is just the bucket of places for a shift.
  Rename adds: `name` (unique per org among active), `call_sign` base (unique per org
  among active), `type`, `parent_assignment_id` (self-referencing parent/child).
  `shift_stops` stays. `patrol_checkpoint_visits` = presence. Tracked as its own
  additive migration + code-sweep (not bundled into FC).

---


## NZ Legal Framework

| Law | Relevance |
|---|---|
| Freedom Camping Act 2011 (FCA) | Primary enforcement act for freedom camping |
| FCA s.20 | Infringement offence, $200 fine |
| FCA s.32 | Notice to Vacate authority |
| Resource Management Act 1991 (RMA) | Noise control, smoke complaints |
| RMA s.38 | Noise Control Officer warrant |
| RMA s.326 | Abatement Notice |
| RMA s.327 | Enforcement Notice |
| RMA s.17A | Smoke complaint authority |
| Biosecurity Act 1993 | Biosecurity inspections |
| Privacy Act 2020 | Data handling, PII access log |
| Local Government Act 2002 | Bylaw authority |
| Summary Proceedings Act 1957 | Court proceedings |

---

## Key Design Principles

1. **Officer portal is glove-safe** — 44px minimum touch targets, night-readable, single task at a time
2. **Offline-first** — scans queue in IndexedDB, sync on reconnect
3. **GPS auto-detects zone** — officer never manually selects zone during patrol
4. **Bob is advisory** — high-impact actions require human approval
5. **Tenant isolation is absolute** — no data from Org A reaches Org B
6. **Audit log is append-only** — no edits or deletes
7. **Secrets never in code** — all credentials via approved secret management
8. **One function per job** — no duplicate edge functions
9. **PostGIS for all spatial** — zone boundaries, GPS, geofencing
10. **RLS on all tables** — no exceptions

---

## Live status against this model (verified 2026-09-14, project `dotczcyyzgabmtmnglqj`)

| Model element | Live truth | Reading |
|---|---|---|
| Assignment bucket (parent/child, call sign, type) | `patrol_routes` carries `call_sign`, `guards_required`, `assignment_type`, `parent_assignment_id`; 4 rows. No `assignments` table. | Concept landed on the legacy table; the `patrol_routes -> assignments` rename is still owed. |
| Stops (site XOR zone) | `shift_stops` has `site_id`, `zone_id`, `module_key`, `is_adhoc`, `dispatch_job_id`, SLA columns. | Present and wired; static = 1 stop, patrol = N stops is expressible today. |
| Three-gate tool resolution | `user_profiles.module_access` (person), `organization_modules` + `site_services(module_key, site_id XOR zone_id)` (place), roster/`shift_stops.module_key` (assignment). | All three gates exist as data; the intersection is computed in UI hooks, not yet as one server-side resolver. |
| Presence | `patrol_checkpoint_visits`, `officer_gps_log`, `shift_stops.actual_arrived_at` | Present. |
| Base toolkit | `officer_field_reports` (incident / H&S / maintenance), suspicious vehicle/person via `entity_flags`/canonical links, checkpoint QR visits, `evidence_items`. | Present; governed by `submit_officer_field_report` and `process-officer-scan`. |
| Specialty verdict spine | `observations` (3,128 rows), `breach_alerts`, `notices`, `infringement_notices`, `enforcement_cases`, `vehicle_overnight_sessions`. | Present. `observations` is the access-doctrine keystone (see `ALIGNMENT_LEDGER.md`). |
| Unified event stream | `location_events` exists with site/zone/checkpoint anchors and `module_key` — **0 rows**. | Dormant: nothing writes it. Treat as an unbuilt seam, not a live spine. |
