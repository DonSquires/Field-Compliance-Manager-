# Noise Control — the two-place model

> Canon (module design under the anchor rule). Owner ruling 2026-09-14 (Don
> Squires), recorded verbatim in intent in §1. Statute verified against
> legislation.govt.nz ("latest" consolidation, retrieved 2026-09-14) — see §4;
> council-specific procedure is tenant data (§5). Lineage: GitLab
> `0238_noise_complaint_address_column.sql` (dual-address, rule #157),
> `0367/0368` (W1 reads + RLS oracles), `EVIDENCE_RE_ANCHOR_LIFECYCLE.md`,
> `NOTICES_HARMED_PARTY_SENSITIVITY.md`; the council noise-control services
> contract and the BWC / NCR SOP in the sample corpus; the Nelson historic
> noise-response export (4,518 attendances). Sits below `FOUNDATION.md`,
> `ACCESS_DOCTRINE.md`, `LOCATION_HOUSE_MODEL.md`, `GEOFENCE_PRINCIPLES.md`.

## 1. The ruling

> "The place of harm is the address the officer attends to conduct the job. The
> tricky one is noise control (and potentially smoke and biosecurity). With
> noise control we need to record the complainant address and the address the
> noise is coming from, and ensure both addresses are associated with each
> other. The officer needs to assess the noise as close to the complainant's
> address as possible without giving away who complained. The address of the
> noise is where the officer will do most of the work, record the assessment
> against, and issue the END or seizure etc. There might be an occasion where
> the officer needs to talk to the complainant — recording that interaction is
> essential as well, and both need to be linked so the report to the client
> reflects exactly what happened. And of course each location needs a geofence
> so there is verification the officer was actually on site."

Read with `FOUNDATION.md` (the offence is established where the harm lands;
the subject is anchored separately; the operator is custodian) and with the
2026-08-17 lineage ruling (#157: repeat-offender logic keys off the **source**
site; the harmed-party read anchors on the **complainant** site). Nothing here
contradicts those; this document is the operational model that makes them true.

## 2. The model — one job, two places, both attended, both geofenced

```
complaint received (statutory precondition for an END, s327(1)(a))
  └── dispatch job  (module_key = noise_control; the ONE chain-of-custody record)
        ├── work place        = the NOISE SOURCE  (dispatch_jobs.client_site_id)
        │     • where the officer does most of the work
        │     • where the assessment is recorded against (noise_assessments.site_id, rule #157)
        │     • where the END is directed / seizure occurs (subject side)
        │     • repeat-offender counts, problem-address flags, prior-END window key off it
        ├── harmed-party place = the COMPLAINANT  (dispatch_jobs.harmed_party_site_id)
        │     • the place of harm; grants the accountability read (W1)
        │     • PROTECTED: identity and contact never on the served document, never
        │       readable from the source side, read only through the guarded path
        │     • the officer assesses as close to it as practicable without revealing it
        ├── attendance = one ad-hoc shift_stop per place attended (presence proof)
        │     • arrival/departure timestamps, GPS + accuracy, geofence verification
        │       result and distance, BWC reference, visit number for re-attendance
        ├── assessment (noise_assessments) — matrix, position, action, END/seizure
        │     • assessment GPS + server-computed distance to complainant and to source
        │     • linked to the source stop and (if attended) the complainant stop
        ├── interactions (job_party_interactions) — "the officer spoke to X"
        │     • complainant / occupant / witness / police; in person, phone, message,
        │       no answer; time, GPS, summary; protected by default; linked to the job,
        │       the assessment and the stop it happened at
        └── client report (get_noise_attendance_report) — exactly what happened
              • both attendances with verification, the assessment, the action, the
                END expiry, Police, delay reasons, outcome; complainant fields
                disclosed only to the custodian and the harmed-party place owner
```

Design decisions and why:

- **No bespoke `noise_jobs` table.** The old prototype had one; the canon says a
  module is data over the shared spines. A noise job is a `dispatch_jobs` row
  with `module_key = 'noise_control'`, and its attendances are ad-hoc
  `shift_stops` — the unified model's own rule ("ad-hoc dispatch becomes an
  ad-hoc stop on the assignment"; static = 1 stop, patrol = N stops, a noise
  job = 1–2 stops). Presence proof is therefore identical to every other module
  and already feeds SLA, timesheets, welfare and client reporting.
- **The harmed party is a second place on the job, not a second job.** Both
  addresses arrive together in the complaint (the Nelson export shows them in
  one free-text field with the complainant's name and phone number — exactly
  the leak the model exists to prevent). They are linked from birth on the job
  row, then carried onto the assessment.
- **Complainant identity is data on the job, held behind a guarded path**
  (`NOTICES_HARMED_PARTY_SENSITIVITY.md` option (a): one preserved event record,
  sensitive fields not on the broadly readable shape). Implemented as a 1:1
  extension row `dispatch_job_protected_parties` with **no** read policy for
  `authenticated`; written and read only through `SECURITY DEFINER` RPCs that
  apply the three-question test and log every read (Privacy Act IPP 6).
  Column-level revokes on `dispatch_jobs` were rejected because they break
  `select *` for every consumer of the busiest operational table.
- **The complainant is never the subject of any served document.** The END, the
  seizure receipt, the s328(5) entry notice show only the source address and
  the recipient. Rendering enforces it; the data layer makes it impossible to
  leak by accident (the source-side reader cannot select the complainant).
- **Assessment position is measured, not asserted.** The server computes the
  distance from the assessment GPS to the complainant's place and to the
  source; the report says "assessed from a public position within *n* m of the
  complainant's boundary" without the address. This is the evidential basis of
  s326 — excessive noise is judged as it interferes with a person *other than*
  one at the emitting place.
- **Geofence verification is loud, never blocking.** Arrival records one of
  `verified_on_site | near_site | off_site | unverified_boundary | no_geofence |
  no_gps` and the distance. It never stops an officer at 2 a.m.; it makes an
  unverified attendance visible on the oversight surface and in the client
  report (`GEOFENCE_PRINCIPLES.md` P1/P2, `ENTERPRISE_READINESS_REVIEW` §5).
- **An END requires a complaint.** s327(1)(a) makes a received complaint the
  precondition of the direction. `submit_officer_noise_assessment` refuses an
  END that is not linked to a dispatch job. Officer-initiated observations
  without a complaint use the abatement path (s322(1)(c)).

## 2.1 Retrospective source-register reconciliation

Owner ruling, 2026-11-07: "complete the jobs as intended by the app, and close
them as intended by the app, do this as a human would." For a pending historical
noise-control job, an administrator may use a source register to record the
source-reported received, on-site, and off-site times and outcome when the
register reference exactly matches the job. The source file name and SHA-256,
reference, local time zone, acting administrator, and reason are retained in an
audit receipt.

This is a narrow historical-record path, not a way to simulate a live officer
visit. The source-reported on-site/off-site values may populate the dispatch
job lifecycle and flow through the normal completed-job ledger projection, but
the outcome must say that the times came from the register. It must not create
GPS coordinates, a geofence result, a shift stop, or an officer attribution
that the source does not establish. These records are source-reported and are
not FCM GPS-verified attendance. Finance may resolve only when a linked shift
identifies an officer and dispatch-origin coordinates cannot be mistaken for
travel evidence; otherwise finance remains for human review.
Any existing response SLA clock is anchored to the register's received time,
not the later import time, before the normal arrival trigger calculates its
verdict. The audit receipt retains both the previous clock and the resulting
source-based response duration; a late response is not erased by reconciliation.

## 3. Confidentiality rules (data layer, not just rendering)

| Reader | Source place, matrix, action, END, times, verification | Complainant place / address | Complainant identity & contact | Interaction summaries |
|---|---|---|---|---|
| Custodian org admin / dispatcher (`is_admin_for_org`, `admin_officer`) | yes | yes | via `get_dispatch_job_protected_party` (audited) | yes |
| Attending officer (assigned, job live) | yes | yes | via the guarded RPC while the job is live (audited) | own |
| Harmed-party place owner (`has_location_access(harmed_party_site_id)`) — the council for a public complaint | yes | yes | no | no |
| Source place owner only (`has_location_access(client_site_id)`) | yes | **no** (redacted) | **no** | no |
| Everyone else | nothing | nothing | nothing | nothing |

`complainant_protected` is forced `true` by the governed submit path. Any
future public/complainant-facing status surface exposes status and reference
only (the old prototype's public portal readable-by-anyone table is a named
anti-pattern; do not port it).

## 4. The legal ladder (RMA 1991, verified 2026-09-14)

| Step | Section | What the record must carry |
|---|---|---|
| Duty | s16 duty to avoid unreasonable noise (best practicable option) | basis for abatement path |
| Complaint received | s327(1)(a) | the dispatch job (time received = notification time) |
| Investigation and opinion | s327(1)(b); s326 meaning of excessive noise (interferes with a person other than one at the emitting place; excludes aircraft in flight, road vehicles, trains except stationary) | matrix / assessment at the complainant's side, exclusions checked |
| Excessive Noise Direction (END) | s327: to the occupier or any person appearing responsible; **oral or written**; prohibits excessive noise from or within the vicinity of the place for **8 days** or a shorter specified period, from the time given (**amended 21 Aug 2025**, 2025 No 41 s77 — previously 72 hours) | `action_taken = 'direction_notice'`, `end_number`, `end_given_orally`, `end_recipient_role`, `end_expires_at = given_at + config.end_validity_hours` (statutory cap 192 h) |
| Non-compliance | s328(1)–(3): enforcement officer **accompanied by a constable** (or a constable) may enter and seize & remove / render inoperable / lock or seal the instrument, appliance, vehicle, aircraft, train or machine | `equipment_seized`, `police_present` mandatory true, `noise_seizures` itemised, s336 costs |
| Unoccupied place | s328(4)–(5): entry and seizure without a direction when no occupier/responsible person can be identified; **must leave** a copy of the written END and a notice (date/time, person in charge, actions taken, inquiries address) | `end_recipient_role = 'unoccupied_notice_left'`, `entry_notice_left = true` |
| Abatement notice | s322(1)(c) for unreasonable noise; s323(2) on non-compliance the officer may enter (constable if a dwellinghouse), reduce the noise, and seize when accompanied by a constable | `abatement_notice`, `notice_number`, a `notices` row served on the subject |
| Return of property | s336: owner may apply any time; return if no likely resumption and all seizing/impounding/transport/storage costs paid; refusal → Environment Court within 6 months; unclaimed 6 months → notice, disposal, costs, remainder on demand | `noise_seizures.returned_at`, costs, disposal record |
| Offences | s338(2) contravening an END or a noise abatement notice; s339(2) fine up to $10,000 + $1,000/day continuing; 12-month limitation from when the contravention became known | `prosecution_referral` with the evidence package |
| Enforcement order | s316 (Environment Court) — the legacy `enforcement_notice` value maps here; it is not an officer-served document | keep the enum value; render as "enforcement order application" |

Council procedure differs (matrix bands, verbal-warning-first policies, END
form numbers, seizure and return fees, response windows). Those are
**tenant data**: `noise_module_config` (bands, threshold, `end_validity_hours`,
`skip_verbal_warning`, permanent-abatement list, legislative text) and
`jurisdiction_rule_sets` — never constants in code. Council websites were not
reachable from this environment (403/405 to automated fetches); the statute
above is primary-source; council overlays are configured, not assumed.

## 5. What the contract and SOP add (sample corpus, generic terms only)

- Coverage windows (after-hours weekdays, Friday evening to Monday morning,
  public holidays) — tenant schedule data; attendance "normally within 60
  minutes"; **every report must state any material delay and its reasons** →
  `dispatch_jobs.sla_delay_reason`, required at completion when the SLA clock
  breached.
- Records required: all complaints; notification, dispatch and attendance
  times (**automated**); assessments and actions; END, enforcement action and
  Police involvement; outcome — this is the attendance report's field list.
- Complainant identity is Personal and Confidential Information; external
  release only via the council (LGOIMA) or under compulsion with notice.
- BWC: job number, type and address spoken on arrival; never covert; **off
  inside a residence during seizure**; recordings purpose-limited →
  `shift_stops.bwc_reference` at arrival.
- H&S: lone worker, aggressive persons, dogs, intoxication, night driving,
  seizure manual handling → pre-arrival dossier (prior END, permanent
  abatement, H&S flags at the source), backup/Police request, `hs_abort_reason`
  as a legitimate outcome.

## 6. Expected vs present (live project `dotczcyyzgabmtmnglqj`, 2026-09-14)

| Element | Present | Gap / this design |
|---|---|---|
| Two addresses on the assessment | `noise_source_address`, `site_id`, `complaint_address`, `complainant_site_id`, `complainant_protected` | present; `complainant_site_id` rarely populated (nothing derives it) |
| Two places on the job | `dispatch_jobs.client_site_id` only | add `harmed_party_site_id`, `harmed_party_address` |
| Complainant identity | nowhere structured (free text in legacy imports) | `dispatch_job_protected_parties` + guarded RPCs |
| Attendance / presence per place | `shift_stops` (arrival/departure, GPS, SLA) exist but nothing creates them for a noise job; `arrived_at/departed_at` on the assessment are officer-asserted | `arrive_at_dispatch_place` / `depart_dispatch_place` find-or-create the ad-hoc stop per `place_role`, verify against the place geofence, record BWC ref, receipt, audit |
| Assessment position | `assessment_gps_*`, `assessment_location` | add server-computed distances to complainant and source; link stops |
| Complainant interaction | none | `job_party_interactions` + `record_job_party_interaction` |
| END validity | `prior_end_within_72hrs` (pre-2025 law) | `noise_module_config.end_validity_hours` (default/cap 192 h), `end_expires_at`, oral/written, recipient role, s328(5) notice — columns live (`20260914110000`); written by `record_noise_direction_particulars` (`20260914120000`, applied live 2026-09-14, oracle-proven) |
| END requires a complaint | not enforced | enforced in the submit RPC |
| Seizure requires Police | `police_present` recorded, not enforced | enforced in the submit RPC for `equipment_seized` |
| Harmed-party read | none on `noise_assessments` live (lineage 0367 never landed) | `20260914100000_harmed_party_read_assessments.sql` (drafted) |
| Client attendance report | none (report packs aggregate counts only) | `get_noise_attendance_report` with basis-scoped redaction |
| Officer UI | single form: source address + assessment GPS + matrix + action | two-place job context, arrive/depart per place, assess, interact, action — Workstream 5 |
| Council-configurable rules | `noise_module_config` bands/threshold, versioned | add `end_validity_hours`; keep everything else as data |
| **Officer submission (latent live defect)** | the live `submit_officer_noise_assessment` (re-issued 2026-09-13) inserts `noise_assessments.shift_id`, a column that does not exist; `20260905008200` had removed it from the INSERT for that reason. Every officer submission has failed since the re-issue (3 audit rows, all earlier). Found by running the RPC in the disposable database. | migration adds `shift_id uuid REFERENCES shifts(id)`; the re-issued RPC keeps the identical signature |

## 7. Build sequence (evidence-gated)

1. **Schema + governed commands** — `20260914110000_noise_two_place_attendance_model.sql`
   (this slice, drafted; owner applies): job harmed-party columns; stop place
   role + verification; protected parties; interactions; assessment links and
   distances; END validity; RPCs `set_dispatch_job_harmed_party`,
   `get_dispatch_job_protected_party`, `arrive_at_dispatch_place`,
   `depart_dispatch_place`, `record_job_party_interaction`,
   `get_noise_attendance_report`; `submit_officer_noise_assessment` derives from
   the job. Guard test `test/noise-two-place-attendance-model.test.js`.
2. **RLS oracle** — `supabase/tests/20260914110000_noise_two_place_rls.sql`,
   41 checks under real RLS (`set role authenticated` + JWT sub), rolled back:
   protected identity unreadable except via the guarded RPC and audited;
   arrival verification; both anchors derived; `complainant_protected` forced;
   END expiry = 192 h; END without a complaint refused; seizure without Police
   refused; delay reason required on breached departure; the report at three
   disclosure levels (custodian / harmed-party owner / source-side owner) and
   `no_basis` for a stranger; W1 harmed-party read, no-leak and no-lockout.
   **Green on 2026-09-14** in the pinned Supabase Postgres image with
   `--network=none`, after loading the live-derived `supabase/schema.sql` and
   both drafted migrations:
   `scripts/run-rls-oracle.sh supabase/migrations/20260914100000_harmed_party_read_assessments.sql supabase/migrations/20260914110000_noise_two_place_attendance_model.sql --oracle supabase/tests/20260914110000_noise_two_place_rls.sql`.
   The same run proved the regenerated `schema.sql` loads cleanly into an empty
   database (357 tables, 555 functions, 861 policies).
   **Direction particulars (added 2026-09-14):** the last 7 checks exercise
   `record_noise_direction_particulars` — receipt returned; written direction to
   the occupier recorded; expiry = `assessed_at` + the officer's 48 h; a period
   beyond the council rule refused; unoccupied entry without the notice refused
   (s328(5)); an oral direction cannot be the one left at an unoccupied place;
   a reader outside the custodian organisation cannot record. Green with the
   live-derived schema plus `20260914120000`. The run also exposed that a fresh
   Supabase database's default privileges widened `dispatch_job_protected_parties`
   to `authenticated`; the snapshot generator now emits table `REVOKE`s so the
   oracle database carries live privileges exactly — live was always correct.
3. **Dispatch intake** — the intake path takes both addresses through the
   canonical site-entry pipeline (Q10) and calls `set_dispatch_job_harmed_party`;
   both places resolve-or-create a house (`LOCATION_HOUSE_MODEL.md`).
   **Applied live 2026-09-14** as `20260914130000_dispatch_place_site_entry.sql`:
   one internal seam `resolve_or_create_dispatch_place_site` (house first;
   dedup by address key within the owner org; a house under another org →
   facet without a house, `ownership_status = 'needs_review'`, never reused or
   forked; provisional centre, unverified boundary; audited) used by both
   `create_dispatch_intake_job` (work place) and `set_dispatch_job_harmed_party`
   (complainant place, now accepting the resolved coordinates). The platform's
   `autolink_client_site_service_agreement` trigger attaches every client-org
   site to its current agreement — that is what gives the custodian access —
   and `site_origin = 'adhoc'` marks these places as not contracted. A
   supplied harmed-party site must belong to the job's client or custodian
   because it grants the W1 read. An address without coordinates stays text on
   the job; no site is invented. Truth table extended to 56 checks.
4. **Officer flow** — job card with both places and the pre-arrival dossier;
   Arrive (source) → Assess (matrix, GPS position, distances shown) → Action
   (END with oral/written and expiry; seizure blocked without Police present;
   s328(5) notice for unoccupied) → optional Contact complainant (interaction,
   arrival at the complainant place if in person) → Depart. Every step a
   governed RPC with a receipt. **Built 2026-09-14** in
   `OfficerNoiseControlPage.tsx`; the direction particulars step opens after an
   END/seizure submission and calls `record_noise_direction_particulars`, with
   the council rule read from `noise_module_config.end_validity_hours` and the
   s327(3)/s328(5) rules mirrored in the form before the server enforces them.
5. **Client report and oversight** — per-attendance report rendered from
   `get_noise_attendance_report`; oversight page flags `off_site`,
   `unverified_boundary`, `no_gps`, SLA breach without delay reason, END
   without complaint, seizure without Police.
6. **Legacy import re-anchor** — the Nelson export's free-text complainant
   details move into protected parties; source and complainant addresses split
   into the two places; each historic attendance becomes a stop with the
   exported on-site/off-site times.

**Gate:** one complaint → dispatch → arrive at source (verified) → assess
(distance to complainant recorded) → END (expires in ≤ 8 days) → speak to
complainant (interaction recorded) → depart → report shows both attendances;
the source-side reader's report has the complainant redacted; the RLS oracle is
green both directions.
