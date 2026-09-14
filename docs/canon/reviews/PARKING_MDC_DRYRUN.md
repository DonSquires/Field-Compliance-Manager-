> **Canonical copy.** Origin: GitLab `don-squires1/field-compliance-manager` `` @ `Main`, read 2026-09-14 via `scripts/gitlab-read.mjs`. This repository (`DonSquires/Field-Compliance-Manager-` `main`) is the authoritative home from now on; the GitLab text is lineage. Edit here and record the ruling — never fork the text. Links to files that do not exist in this repo refer to that lineage.

# MDC Parking Enforcement - dry-run mapping + digital chalking design

**Status:** DRY RUN - review only. No database writes yet. Once the owner confirms
the mapping below is correct, it becomes an idempotent seed migration + module changes.

**Source:** Contract 10111 Marlborough District Council Parking Enforcement (RFP
Section D Contract Scope) + the live FS Nelson Deputy export (`SGPWA`/`SGPSU` rows).

**Owner decision captured:** parking warden work is a **patrol route** (parking_enforcement
module), NOT a static site. **Manual chalking is replaced by DIGITAL CHALKING via
vehicle scan** - the same ALPR + movement-detection engine as freedom camping
(`process-officer-scan`).

---

## 1. Contract structure -> our schema

### Client
| Entity | Value | Our table |
|---|---|---|
| Client org | Marlborough District Council (administered by NZTA) | `organizations` (type `client`/`government`) |
| Service provider | First Security (the Contractor) | existing provider org |
| Service agreement | Contract 10111, 6-year liability, quarterly performance review | `service_agreements` + `agreement_obligations` |

### Two enforcement areas = two parking patrol routes
| Route | Module | Seasonal? | Wardens |
|---|---|---|---|
| **Blenheim** | parking_enforcement | No | 2 weekdays (09:15-16:45 active), 2 Saturdays (10:15-12:45 active) |
| **Picton** | parking_enforcement | **Yes** - Low (1 Apr-30 Nov) / High (1 Dec-31 Mar) | 1 warden; Sat coverage differs by season |

- Routes -> `patrol_routes` (one per area), `module_key='parking_enforcement'`.
- Enforcement hours -> `client_site_patrol_config.window_start/end` per stop.
- Picton seasonality -> `client_site_patrol_config.time_window_type='seasonal'` +
  `active_months` (Low = {4,5,6,7,8,9,10,11}, High = {12,1,2,3}).

### Blenheim zones (RFP 2.3.8) -> `location_zones` (parent = Blenheim route)
- **ALPHA**: Market St (Main-Wynen), Alfred St, Wynen St, Russell Tce, Symons St,
  High St, Queen St, Charles St, Twelfth Lane, Liz Davidson Carpark, High St Carpark,
  Wynen St Carpark, Alfred St Carpark, Clubs of Marlborough car park.
- **BRAVO**: Arthur St (Market-Seymour), Market St (Wynen-Alfred), George St, Maxwell Rd,
  Scott St, Kinross St, Main St, Seymour St, Stadium P150 (front/rear), Scott/Kinross
  Carpark, Kinross St Carpark, Countdown Carpark, Fairweathers (Tenth Lane), Railway
  station car park.
- **OUTERS**: Freswick St, Opawa St, Redwoodtown, Henry St, Auckland St, Springlands.

### Blenheim stops + minimum patrol frequency (RFP 2.3.9)
| Stop | Weekday min | Saturday min |
|---|---|---|
| CBD kerbside meters | 3x/day | 2x/day |
| Alfred Street car park building | 2x/day | 1x/day |
| Scott/Kinross Street | 2x/day | 1x/day |
| Kinross Street | 2x/day | 1x/day |
| Queen Street Pocket Park (Liz Davidson) | 2x/day | 1x/day |
| Clubs of Marlborough | 2x/day | 1x/day |
| High Street | 2x/day | 1x/day |
| Wynen Street | 2x/day | 1x/day |
| Railway Station | 1x/day | 1x/day |
| Railway Street P60 | 1x/day | - |
| Park Terrace P60 | 1x/day | - |
| Horton Street P120 | 1x/day | - |
| Rear Stadium Car Park P150 | 1x/week | - |
| Stadium P150 | 2x/day | 1x/day |
| Tenth Lane car park P120 | 2x/day | 1x/day |
| Countdown Car Park P120 | 2x/day | 1x/day |
| Theatre Trust P90 | 2x/day | 1x/day |
| Kinross St (Police Station) car park | 1x/day | 1x/day |
| Seymour Street car park | 1x/day | 1x/day |
| Theatre Trust leased (Wynen, Noel Leeming, Alfred St) | 1x/day | 1x/day |
| Springlands | 1x/week | - |
| Redwoodtown | 1x/week | - |
| Francis / Freswick / Opawa St | 1x/week | - |
| Sutherland Tce / Park Tce / Auckland St | 1x/week | - |
| Nelson St / Hutcheson St | 1x/week | - |

### Picton stops + frequency (RFP 2.4.10 Low / 2.4.11 High)
| Stop | Low wk | Low Sat | High wk | High Sat |
|---|---|---|---|---|
| Coathanger (Pay by Plate) | 1x | 1x | 2x | 2x |
| High Street (Pay by Plate) | 1x | 1x | 2x | 2x |
| Dublin Street (Pay by Plate) | 1x | 1x | 2x | 2x |
| P60 kerbside car parks | 3x | 3x | 3x | 3x |
| Ferry Terminal P60 (Port Marlborough) | 1x | 1x | 2x | 2x |
| Interislander Long Stay | 1x | 1x | 2x | 2x |
| Bluebridge / Straight Shipping Long Stay | 1x | 1x | 2x | 2x |

- Port Marlborough car parks: enforce **30 min either side of ferry arrivals/departures**
  (event-driven window - not a fixed clock window; see gap #3).
- Picton zones -> `location_zones`: **Picton CBD** + **Port Marlborough**.

---

## 2. Digital chalking via vehicle scan (replaces manual chalk)

**Today:** officer types a plate, sets a return-minutes timer, optional photo ->
`parking_chalk_records` (status active -> overstay when `return_by` passes). Manual.

**New model (mirrors freedom camping):**
1. **First pass (chalk):** officer scans the parked vehicle via `process-officer-scan`
   with `module_key='parking_enforcement'`. Captures plate (ALPR), **GPS**, timestamp,
   and a vehicle **embedding**. This is the digital chalk mark - no physical chalk.
2. **Time limit:** resolved from the stop's `location_zones` rule (P60/P120/P150/meter)
   via `resolve_context.effective_rules`, instead of a manually picked timer.
3. **Return pass (verify):** officer scans the same bay later. The scan pipeline's
   **movement detection** (embedding compare, `/infer/compare`, same as FC overnight)
   decides moved vs stationary. Stationary past the time limit = **overstay** ->
   infringement candidate.
4. **Infringement:** existing notice flow (`generate-notice` + fire-control key),
   gated by the org/zone enforcement workflow mode (3.4).

**Why this is a clean reuse:** the scan, ALPR, embedding, movement-compare, evidence
watermarking, and notice pipeline ALL already exist for freedom camping. Parking just
needs: (a) a time-limit rule per stop, (b) a parking-specific "same bay, stationary,
over limit" verdict instead of the FC overnight verdict.

**What changes in code (next MRs, not this doc):**
- Parking module: add a **Scan to chalk** action (camera -> `process-officer-scan`),
  alongside/replacing the manual chalk form. Keep manual entry as a fallback.
- A `parking_time_limit_minutes` (or reuse `location_zones.active_schedule`/rule) per
  stop so the limit is data-driven (P60=60, P120=120, P150=150, meter=metered).
- A parking verdict in the scan response: `parking_status` (within_limit / overstay /
  moved) derived from movement + elapsed time vs the bay's limit.
- `parking_chalk_records` gains `first_observation_id` / `return_observation_id` +
  `gps_lat/lng` + `movement_decision` so a chalk is two linked scans, not a timer.

---

## 3. Gaps the contract exposes (tracked, not blocking the seed)

1. **Weekly patrol frequency.** `client_site_patrol_config.visits_per_shift` is per-shift;
   the RFP has "once per week" stops. Add a weekly cadence (reuse `frequency_rule` jsonb
   from 0060, or add `visits_per_week`).
2. **Coverage rule: min 1 warden central, never <2 at 12-1pm, Redwoodtown swap max 1h.**
   Roster-level constraint; no current engine. -> roster gap, future.
3. **Event-driven windows (Picton ferry +/-30 min).** Not a fixed clock window. Needs a
   ferry-schedule input or a manual "ferry window" toggle. -> future.
4. **Weekly occupancy survey (Zone 1 kerbside, Thu 11am, Report 1).** A scheduled data
   capture + report. -> `agreement_obligations` + a survey form + report pack.
5. **Performance measures as obligations:** max 12 erroneous infringements/Warden/month;
   complaint ack 12h / report 24h / response 5 working days; bi-monthly client meeting;
   quarterly performance review. -> `agreement_obligations` + SLA layer (3.1).
6. **Body cameras: on entire shift, daily download, 12-month retention.** A real evidence
   + retention obligation with no current home. -> evidence/retention policy, future.
7. **Warden warrant (s128E Land Transport Act 1998 -- corrected from s128D per the
   NZTA Blenheim/Picton warden training manual) + Certificate of Approval carried on
   duty.** -> `staff_credentials` types `parking_warrant` + `certificate_of_approval`;
   roster gate blocks rostering without a current warrant.
8. **Pay-by-plate meter faults (Orikan) reported by warden.** Minor: a fault-report
   action. -> future.

---

## 4. Proposed build order (after this dry run is approved)

1. **Seed migration** - MDC client org + Blenheim/Picton parking routes + zones + stops
   + per-stop frequency & hours (idempotent; no PII). Verifies the parking route model
   against a real contract.
2. **Digital chalking** - parking scan-to-chalk + return-verify via `process-officer-scan`
   movement detection; data-driven time limits; parking verdict. Keep manual fallback.
3. **Parking obligations** - performance measures (#5), warrant credentials (#7),
   occupancy survey (#4) into the obligation/SLA layer for contract-performance reporting.
4. **Roster coverage rules** (#2) + ferry windows (#3) + body-cam retention (#6) - later.

---

## 4b. Old-app review findings (FreedomCamp-Manager) - what to reuse vs avoid

Reviewed the old build (the "almost ready but built wrong" app) for its digital-chalking
and legal-enforcement systems. Conclusion: **do NOT port its parking schema - ours is
already stronger.** Reuse its requirements checklist, not its tables.

**What the old app actually had:**
- `chalk_passes` table = `(plate_number, zone_name, chalked_at, officer_id)` only.
  **No GPS, no evidence link, no return-verification, no movement proof.** Thinner than
  our current `parking_chalk_records`, and far thinner than our FC scan pipeline.
- `enforcement_actions` = a generic action queue (type/plate/zone/status), not court evidence.
- The real legal depth lived in the **freedom-camping evidence pipeline**, NOT in parking:
  EXIF GPS + timestamp + device captured on every photo; watermarked immutable evidence;
  an evidence-review -> formal-decision -> dispute chain; jurisdiction notice templates.
- Officer flow: PlateScanCommandPanel (command-shaped scan: manual + ALPR + offline all
  through one validation path) -> EvidenceUploadQueuePanel -> BreachNoticeCommandPanel;
  admin EvidenceReviewPanel + FormalDecisionPanel for disputes.

**The lesson (owner's point confirmed):** the old app had the right *systems* but built
them fragmented - parking chalk was a stub disconnected from the evidence engine. Our new
build already has the stronger foundation (`process-officer-scan`: watermarked evidence,
GPS, observation IDs, embedding movement-compare + the Layer 3.3 dispute pipeline). So
digital chalking should be built on the FC scan engine, NOT on a ported chalk table.

## 4c. Court-ready evidence requirements (legal enforcement role)

Parking enforcement issues legal infringement notices that may be disputed in court, so
every chalk / overstay / notice MUST carry a defensible evidence chain. Derived from the
old-app review + the FC pipeline we already have:

1. **Immutable, watermarked photo evidence** at both the first (chalk) and return (verify)
   scans - plate, timestamp, GPS, officer, observation id burned into the image (the FC
   `storeScanEvidence` watermark already does this).
2. **GPS + timestamp + device** captured on every observation (EXIF + server-side), so the
   bay location and times are provable independently of officer assertion.
3. **Linked two-scan chain:** first_observation -> return_observation -> movement_decision
   (stationary/moved) -> elapsed vs the bay time limit -> overstay verdict -> notice. Each
   step timestamped and stored; nothing inferred from a manual timer alone.
4. **Strict same-bay GPS tolerance** on the return scan (owner: "quite strict"). Proposed
   default ~5 m (tighter than the FC 10 m on-site radius) since a parked car has not moved;
   configurable per zone. A return scan outside tolerance does NOT auto-overstay - it is
   flagged for officer confirmation (avoids false positives that fail in court).
5. **Per-zone time limit with provenance:** the limit (P60/P120/P150/metered) is stored on
   the zone AND backed by a **signage photo** that Bob reads (OCR) to set the limit. The
   signage photo + Bob's reading + the human approval are retained as the *authority* for
   the limit, so a disputed notice can show "the posted sign said P60, here is the photo".
6. **Full audit + retention:** infringement evidence retained **24 months**; non-infringement
   scans purged after **7 days** unless a retention hold (with a days value) is set. See 4e.
7. **Human fire-control before issue:** officer types their full name to authorise notice
   generation (already built: `HumanFireControlKey`), recorded against the notice.
8. **Dispute pathway:** the public dispute portal + admin review (Layer 3.3) already routes
   to the canonical `disputes` table; parking notices must link their evidence chain to it.

## 4d. Per-zone signage photo -> Bob-read time limit (new capability)

Owner requirement: each zone has a **photo of the time-limit sign**, read by Bob, and the
limit written into that zone's parking rules.

Flow (governed, court-defensible provenance):
1. Admin (or warden) uploads the signage photo against the zone.
2. Bob OCRs the sign (e.g. "P60", "P120", "Metered Mon-Sat 8am-6pm") via the photo
   classification path (`classify-photo` / Bob document intelligence).
3. Bob proposes the parsed limit as a governed action (set zone parking rule) -> human
   approves in the bell -> executor writes `location_zones` parking rule + keeps the
   signage photo url + Bob reading + approver as provenance.
4. The scan verdict then reads the limit from the zone (via `resolve_context`), so overstay
   is judged against the *posted, photographed, human-approved* limit - defensible in a
   dispute.

This reuses the existing Bob governed loop (promote -> approve -> execute); it adds a
`set_zone_parking_rule` action type, not a new ungoverned write path.

## 4e. Confirmed decisions (owner, locked for build)

1. **Same-bay GPS tolerance: 5 m** (configurable per zone; adjust later if needed).
2. **Evidence retention (legal) - POLICY-DRIVEN PER ORG (councils differ by bylaw):**
   Retention periods are NOT hardcoded. Each council/client sets its own bylaw-driven
   periods via a `retention_policies` table (org-scoped, optional per-module). Defaults seed
   to the MDC values but every tenant can override in admin settings.
   - **MDC defaults:** infringement = **730 days (24 months)**; non-infringement scan =
     **7 days**; then purged.
   - **Retention hold:** any record can be flagged to retain, with a **period in days** (e.g.
     abandoned vehicle held 90 days). Hold overrides the non-infringement default.
   - `retention_policies(organization_id, module_key null, category, retention_days,
     legal_basis text, is_active, effective_from, created_by)`. `category` in
     ('infringement','non_infringement','hold_default').
   - Each observation/evidence row carries `retention_until timestamptz` + `retention_reason`
     + `retention_hold boolean` + `retention_hold_days int`. `retention_until` is COMPUTED
     from the applicable policy when the record's status is set (scan -> non_infringement
     period; infringement issued -> infringement period; hold -> hold days), NOT from a
     constant. The scheduled purge deletes non-infringement evidence past `retention_until`
     unless `retention_hold = true`; it never touches infringement evidence inside its window.
   - **Why:** the platform is multi-council SaaS; retention varies per tenant like enforcement
     workflow mode and module enablement already do. `legal_basis` (e.g. "MDC Parking Bylaw
     cl. X / Privacy Act 2020") is itself court-useful - a dispute can show the authority for
     the retention period.
   - **Resolution:** module-specific policy for the org wins; else org-wide default; else the
     platform fallback (730 / 7). A helper `resolve_retention_days(org, module, category)`
     returns the effective number.
3. **Time limits are data-driven AND adjustable in the zone rules.** Seed the RFP values
   (P60=60, P120=120, P150=150, metered, P90=90) but every limit is editable in the zone
   Rules editor (and settable from the Bob-read signage photo). One field:
   `parking_time_limit_minutes` on the zone (null = metered/no fixed limit).
4. **Disabled (mobility) parking = DOUBLE the posted time limit.** A per-scan modifier: when
   the bay/permit is disabled parking, effective limit = `parking_time_limit_minutes * 2`.
   Surfaced as a `disabled_bay` flag on the scan (officer sets, or permit detected) and a
   `disabled_multiplier` (default 2) on the zone rule so it is adjustable.

### Parking rule fields added to `location_zones` (seed migration)
| Field | Purpose |
|---|---|
| `parking_time_limit_minutes` int null | Posted limit; null = metered/no fixed limit. Editable. |
| `parking_disabled_multiplier` numeric default 2 | Disabled-bay limit multiplier (2 = double). |
| `parking_signage_photo_url` text | The photographed sign that is the authority for the limit. |
| `parking_limit_source` text | 'bob_signage' / 'manual' / 'rfp_seed' - provenance of the limit. |
| `parking_limit_set_by` uuid | Who/what approved the limit (human approver of the Bob proposal). |

### Retention model (seed migration)
**New table `retention_policies`** (org-scoped, configurable per council/module):
| Field | Purpose |
|---|---|
| `organization_id` uuid | The council/client the policy belongs to. |
| `module_key` text null | Optional module scope (null = org-wide default). |
| `category` text | 'infringement' / 'non_infringement' / 'hold_default'. |
| `retention_days` int | The period for that category. |
| `legal_basis` text | Bylaw / statute reference (court-useful). |
| `is_active` bool, `effective_from`, `created_by` | Governance/audit. |

**Per-record fields** (on the observation/evidence rows):
| Field | Purpose |
|---|---|
| `retention_until` timestamptz | When the record may be purged (computed from policy). |
| `retention_reason` text | e.g. 'infringement', 'default', 'hold_abandoned_vehicle'. |
| `retention_hold` boolean default false | True = never auto-purge while held. |
| `retention_hold_days` int null | The hold duration in days when a hold is applied. |

**Helper:** `resolve_retention_days(org_id, module_key, category)` -> effective days
(module policy -> org default -> platform fallback 730/7).

## 5. Owner decisions - RESOLVED (build can proceed)

- **Seed live data: YES** - via the normal migrate pipeline.
- **Chalk modes: BOTH** digital (scan) + manual, officer-selectable. Manual stays as a
  fallback when camera/ALPR is unavailable.
- **Time-limit source of truth:** stored on `location_zones` (`parking_time_limit_minutes`),
  seeded from the RFP values, **adjustable in the zone Rules editor**, and settable from the
  Bob-read signage photo.
- **GPS bay tolerance: 5 m** (configurable per zone; adjust later). Out-of-tolerance return
  scans flag for officer confirmation rather than auto-overstay.
- **Retention: POLICY-DRIVEN per council** (configurable; bylaws differ). MDC defaults
  24mo infringement / 7d non-infringement + holds with a days value. See 4e for the model.
- **Disabled (mobility) parking = 2x posted limit** (per-zone `parking_disabled_multiplier`,
  default 2; per-scan `disabled_bay` flag).

## 6. Build order (locked)

1. **Seed migration** - MDC client org + Blenheim/Picton parking routes + zones + stops +
   per-stop frequency/hours; + parking rule fields on `location_zones` (time limit, disabled
   multiplier, signage photo + provenance); + the `retention_policies` table + per-record
   retention fields + `resolve_retention_days()` helper; + seed MDC's default policies
   (730 / 7). Idempotent, no PII.
2. **Digital chalking** on the FC scan engine - scan-to-chalk + return-verify via movement
   detection; effective limit = `parking_time_limit_minutes * (disabled_bay ? disabled_multiplier : 1)`;
   5 m bay tolerance; manual fallback; court-ready evidence chain; set `retention_until` on issue.
3. **Signage photo -> Bob-read limit** - `set_zone_parking_rule` governed action (promote ->
   approve -> execute), photo + OCR + approver kept as provenance.
4. **Retention purge job** - scheduled: delete non-infringement evidence past `retention_until`
   unless `retention_hold`; never touch infringement evidence inside its window. Periods come
   from `retention_policies` (per council), NOT hardcoded. + a small admin UI to edit a
   council's retention policy (with `legal_basis`).
5. **Parking obligations** (3.1 layer) - 12-error/Warden/month cap, complaint SLAs, weekly
   occupancy survey, warden warrant (s128E LTA -- corrected from s128D) + COA credentials.
