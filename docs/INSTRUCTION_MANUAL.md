# Field Compliance Manager (FCM) — Canonical Instruction Manual

**Platform**: Enterprise Field Operations & Compliance Management Platform  
**Architecture Spine**: Multi-Tenant Canonical Identity Spine + Module-Independent Vertical Architecture  
**Document Status**: Authoritative Product Truth & System Guidance  
**Timezone**: NZ Standard / Daylight Time (Pacific/Auckland)

---

## 1. Executive Product Vision & Core Principles

Field Compliance Manager (FCM) is an enterprise SaaS platform designed to replace multiple single-purpose field applications used by security companies, field compliance contractors, and local councils (e.g. separate apps for noise control, parking, freedom camping, patrol routes, static guarding, biosecurity, smoke complaints, PTT dispatch, and welfare monitoring) into a single, unified platform.

### Core Build Doctrines

1. **Multi-Module Vertical Independence**:
   - Every module (Freedom Camping, Parking Enforcement, Noise Control, Biosecurity, Smoke Control, Static Guarding, CRM, Rostering, HR, Finance, Welfare) can run 100% standalone or in any mixed subscription combination.
   - An organization can subscribe to Noise Control only, Freedom Camping only, Parking + Welfare, or the entire suite without missing dependencies.

2. **Global Canonical Identity Spine**:
   - Universal identity anchors for `organization`, `place` (`locations`, `client_sites`, `location_zones`), `person`, `vehicle` (ALPR/plate), and `scv` (certifications).
   - Operational records (observations, breaches, assessments, chalks, notices, GPS evidence) attach to these canonical identities, maintaining historical continuity across multiple contractors and councils.

3. **100% Honest & Court-Ready Evidence**:
   - Every observation, notice, chalk, assessment, and report carries immutable provenance (timestamp, GPS coords, verified geofence boundary, officer ID, vehicle plate, photo hashes, and statutory authority).
   - **Zero Silent Fabrication**: Unverified or missing facts are explicitly marked as unknown. No record is ever guessed or fabricated.
   - **Tamper-Evident Audit Chains**: Append-only audit receipts ensure records stand up in court, council hearings, and legal reviews.

4. **Bob Dual-Mode AI Integration**:
   - **Heuristic Field Copilot:** Integrated into all portals via a simple, voice/panel interface ("Ship's Computer") for contextual field assistance, hazard alerts, shift debriefs, and evidence drafting.
   - **Advanced Owner/Grand-Master Studio:** A multi-media/multi-ability studio allowing owners and grand-masters to work directly with Bob inside the platform to build, extend, test, and release app capabilities safely via disposable worker containers (`bob-control-plane-server.js`).
   - **Evidence Compiler:** OCR, ALPR, vision, enhancement and document services
     produce structured candidates, conflicts and provenance before a language
     model interprets them. Response confidence is not field verification.
     High-risk identifiers that lack deterministic evidence are displayed as
     `[TO CONFIRM]` and cannot enter canonical proposals. Identity, legal,
     enforcement and commercial truth requires an attributable human decision.
     Shared receipts live in `perception_evidence_envelopes`, candidate fields
     in `perception_evidence_fields`, model evaluation evidence in
     `perception_model_calibrations`, and append-only human decisions in
     `perception_evidence_reviews`. Raw candidates are currently
     administrator-only; domain adapters must add the proper task-entitlement
     policy before widening access.
    - **CCTV ALPR receipts:** Plated CCTV observations are projected into the
     shared evidence spine only after source/enhanced derivatives are stored.
     Original hashes, raw/corrected OCR, frame location, quality floors,
     temporal consensus and disagreements remain visible. Machine consensus
     never removes review; the existing CCTV observation review is the one
     human decision mirrored into shared authority and append-only history.
    - **CCTV person/face receipts:** Shared receipts contain source custody,
     presence, face model/provider/crop provenance and a pseudonymous portfolio
     candidate, but never raw biometric vectors or candidate identity lists.
     Face similarity stays provisional until relevant-condition and
     demographic calibration exists. Only an explicit human CCTV identity
     link can create a human-approved identity reference.
    - **CCTV vehicle attributes:** The vehicle review card shows make, model,
     colour, body type, year, source and model confidence when available.
     Confirm only what the evidence supports, correct any wrong field, or
     dismiss the candidates. Accepting a plate links vehicle identity but does
     not promote visual attributes. Only this explicit attribute review can
     update the canonical vehicle, and every decision is attributable.
   - **Self-Heal Boundary:** Bob may reproduce, edit, test, independently
     verify, repair and prepare a draft release in an isolated worker. Schema,
     auth/RLS, secrets, protected-branch merge, deployment and destructive bulk
     effects still require a human to turn the key.

---

## 2. Platform User Shells & UX Standards

| Shell | Target Roles | Interface Density | Key Metaphor & Purpose |
|---|---|---|---|
| **Officer Shell** | Field Officers, Specialist Officers | Glove-Safe (≥44px targets, high-contrast Night Patrol theme) | Mission Board → Active Task Execution |
| **Admin Shell** | Admins, Admin Officers, Dispatchers | Standard to Dense | Queue Triage, Dispatch, CRM, Rostering & Finance |
| **Master Shell** | Master, Grand Master | Policy & Governance | Multi-tenant setup, platform terms, module subscriptions |
| **Bob Studio** | Owner, Grand Master | IDE / Multi-Ability Studio | Continuous in-app build, testing, and system extensions |

### Client and location setup

- Open **Clients**, then **Set up a new client**. Enter the client name and
  confirm that your provider is engaged. Email, phone and notes are optional.
  Choose an existing matching organisation instead of creating a duplicate.
- Save the client, then use **Add location**. A location name is enough to
  record an unverified site or area. No address, price, schedule or invitation
  is required at this stage.
- Select a location row to open its profile. Edit its name, notes and site
  briefing/access/safety details; an address can be selected from address
  search. **Scheduling and services** retains the client/site context.
  **Reporting and activity** shows records for that location's sites/zones.
  **Map, areas and restrictions** opens the existing specialist editor.
  Delivery editing requires an existing client. A delivery link without one
  opens the same simple setup form, not the former organisation/contact wizard.
  Provider context follows the client into its profile and delivery editor.
  Where several sites share a location, choose the intended active site before
  opening scheduling. Area-only locations open agreement/service configuration
  rather than defaulting to another site's schedule.
- In the officer portal, open **Tools** and use **Places**. Select the client and existing
  location, or add a new one. If several site/area boundaries share the
  location, choose the intended boundary. Capture GPS, inspect the map and
  correct the point if needed, then confirm and save.
- Accuracy worse than 10 m is a warning, not a claim of precise GPS. The
  original fix/time/accuracy and corrected point are retained. Captures older
  than ten minutes must be reacquired. Failed tiles cannot be confirmed.
- The admin row/profile displays **Officer verified** after persistence. This
  means a separate 10 m reference point was confirmed, not that the perimeter
  or legal rules were verified. Existing boundaries and officer history remain.
  To move or re-verify that reference point, capture it again through **Places**;
  the specialist boundary editor cannot overwrite its verification provenance.
  Reference points are not delivery locations, work areas or restriction targets.
  Offline captures are not queued by this workflow; wait for the save receipt.
- A stale-record error requires reloading before retrying. Multiple current
  agreements require an administrator to review the intended engagement
  rather than allowing the form to guess. Contacts, invitations, prices and
  advanced readiness/handoff tools remain available separately.

### Vehicle search and cross-area subject trends

- In **Vehicle Search & Flags**, enter any part of a registration. Plain text
  matches anywhere; `%` matches zero or more characters. For example, `RJ%9%8`
  finds registrations beginning with RJ, followed by 9 and ending in 8;
  `%yg%%4` finds registrations containing YG and ending in 4. Matching is
  case-insensitive. Select a registration before inspecting history or raising
  flags. Broad searches show the first 50 matches and ask you to refine.
- **Back to search results** restores the previous registration pattern and
  result list without rerunning the search, including after a detail-load error.
- **Open in new window** (on the page) or the pop-out icon beside **Vehicle
  search** in the top bar opens vehicle search in its own window, without the
  admin navigation, so it can be moved to another screen while you work
  elsewhere in FCM. It keeps your sign-in, working organisation and access
  rules. Opening it again reuses the same window; from the page it opens on the
  selected registration. If nothing appears, allow pop-ups for the site.
- Search results show each vehicle's profile photo as a thumbnail when one
  exists and you are authorised to see it; vehicles without a photo show an
  empty placeholder.
- A selected vehicle opens as one **Vehicle profile** card: the profile photo
  beside the registration, make/model, of-interest flag action and warrant/
  certification status. **Edit vehicle details** and **Add/Replace profile
  photo** open their forms only when needed.
- **Observation History** is a spreadsheet-style table (latest 50): photo
  thumbnail, observed time, location/zone, type, plate and vehicle seen,
  outcome, nights and reason. Thumbnails appear only for photos stored in an
  organisation you can access; select one to open the full photo.
- In a selected vehicle's **Vehicle profile**, an organisation administrator
  can edit make, model, year, colour, body type and registration/WoF/CoF expiry
  dates with a reason/source. Blank fields leave existing values unchanged.
  Registration is fixed. These are shared facts: an administrator of any
  organisation can correct them, every change is audit-logged with before/after
  values, and the profile shows when the details were last updated and by which
  organisation. Organisation notes are preserved. VIN and registration identity
  checks remain in their existing evidence-review workflow.
- **Owner, drivers and associated people** (administrators and authorised users)
  links people to the vehicle: **Add owner** / **Change owner** (one current
  owner), **Add driver** and **Add associated person** (any number). Create a
  new person (name, contact, street address, suburb and town/city) or choose an
  existing person record, give the source (NZTA motor vehicle register — owner
  only —, owner or driver told us, officer established on site, other) and the
  basis. New people are added to your person records and the canonical person
  registry. People your organisation has authorised for **Vehicle owner
  details** (Users → open the person → Restricted information, or an access
  preset) and administrators see the full details, including the address, on
  every screen that shows them. Everyone else sees only that the owner (or
  driver) has been identified and the suburb and town/city. Owners sourced from
  NZTA are marked **NZTA restricted** and must only be used for the purpose they
  were obtained for. An NZTA-sourced person is labelled **Registered person (at
  check date)** — not proof of ownership — and stays hidden until an authorised
  user chooses **Reveal with a stated purpose**, picks the Gazette purpose (or
  the notice being followed up) and writes the reason. The details stay visible
  to that user for 15 minutes (timed by the server, so the screen hides them
  again even if the device clock is wrong) and the view is logged. **Following
  up a trespass or warning notice** is offered only when an issued notice about
  that person or vehicle exists. The same reveal applies in Person search and
  the identity records workspace; in the identity records workspace, hidden NZTA
  records are listed by plate ? open the vehicle, reveal, then choose **Review
  this NZTA record**. **No longer owner / driver** ends a link with a reason. The
  owner can also be added from the repeat-subject drawer.
- **NZTA register (s241)** (Admin → Investigations & Evidence, admin-tier only)
  keeps the records NZTA can ask for: **Lookup register** (record every Motochek
  lookup with the individual user, purpose, reason and later the outcome;
  historical checks without a purpose are flagged), **Access log** (every
  in-app reveal), **People & training** (record training and confidentiality,
  each valid for up to 12 months; a new NZTA tick cannot be saved until both
  are current — choose **Staff without access** to record them for someone
  before granting access; administrators from a parent, provider or platform
  organisation who can see the register are listed too), **Quarterly reviews**,
  and the **Annual summary** with per-zone signage evidence and the retention
  counts (18 months, 2 years and 5 years; report only, nothing is deleted).
  Training and confidentiality belong to the person and count in every
  organisation they can view. NZTA source documents and NZTA owner links cannot
  be read directly from the database tables; they are only returned through a
  logged reveal. Historical checks can be linked to the recorded lookup that
  explains them with **Link to recorded lookup**. The lookup register, access
  log and annual summary export CSV; the summary also prints, for the period
  shown only. If a period has more entries than the screen can list, a banner
  says so and export is turned off until the dates are narrowed.
- A flagged vehicle's profile has a border in the colour of its highest active
  flag (red for high/critical, amber for medium, blue for low) and a risk
  banner at the top listing the active flags.
- **Observation History** shows the first photo of each sighting (the scan
  photo, otherwise the first photo attached later). Click a row to open the
  sighting on the right of the list; **Pop out full screen** shows the same
  sighting with every update option. From the panel: add a note, request or
  resolve a follow-up, record an H&S concern, attach a photo from file, record
  the driver or another person **at this sighting**, and (administrators of the
  organisation that recorded it) **Send to investigation** — a new
  investigation, or one already open; the sighting and vehicle are linked. The
  original observation is never changed. The **Status** column shows
  **Flagged**, **Notice issued** (or prior notices), **H&S**, **Follow-up
  open** and the number of updates.
- Administrators can add or replace the shared vehicle profile photo using a
  JPEG, PNG or WebP up to 5 MB, preview it, and record a reason/source. The app
  resizes/re-encodes the image to remove embedded location metadata before
  upload. Do not include people or private surroundings. Photos use private
  storage and expiring links: another organisation only sees the photo through
  existing custody or caller-visible vehicle observation access. The picture
  is not public, identity proof, or enforcement evidence. Replacements retain
  previous photo receipts in audit history. If upload succeeds but linking
  fails, retry **Save profile photo** to reuse the uploaded file.
- In **Reports & Accountability**, the **Logged activity and officer notes**
  search covers every recorded field (comments, issue, action notes, plates,
  people, officer names, source files) and appended updates, across all dates.
  Type at least two characters; clear the search to browse by date window. Open
  a record to add follow-up notes or photos alongside it.
- **Repeat subject review** is its own tab in Reports & Accountability. Choose
  **All
  authorised agreements and observations** to compare subjects across areas,
  including observations without an agreement mapping, or choose one agreement
  to narrow the review. The existing R&M administrator identity permission
  remains required; this is not a platform-wide disclosure option.
- Select **1 time (all subjects)** in either subject list to include subjects
  seen only once. Vehicle and verified-person lists use the selected period.
  Counts combine patrol sightings and accepted CCTV observations, not unreviewed
  detections or unlinked comment mentions. Open a subject to inspect its history,
  place and recorded officer context; comment mentions remain separate evidence
  requiring review. In a vehicle's drawer: **Correct canonical vehicle
  details** opens Vehicle Search & Flags; authorised users can add owner
  identity and open **Identity…** for aliases, merge review, and ID-evidence
  submission. Each patrol sighting shows its status badges and takes follow-up
  notes and photos. In **People mentioned**, any member can add people as
  **Unconfirmed** (or select an existing person) and administrators can confirm
  a verified person or set the identity of record.

---

## 3. System Section & Role Matrix

### Section 1: Platform Owner & Grand Master (`grand_master`, `master`)
- Multi-tenant setup, platform subscription terms, self-serve module catalog management, global capability inspection, and Bob Builder Studio governance.

### Section 2: Service Provider Administration (`admin`, `admin_officer`)
- Client portfolio management (CRM), service agreements, site/zone geofence management, workforce rostering, HR leave & credentials, and operational finance.
- On a roster slot, set optional break minutes and **unpaid** when applicable;
  creation, editing and repeat/copy retain the plan. The allowance is not an
  automatic deduction.
- In HR timesheets, use **Recover scheduled shift into timesheet**, then
  **Preview scheduled rows**, amend the actual times and give a reason before
  **Save manual timesheet for review**. This creates reviewable administrative
  provenance, not fabricated GPS attendance. Another authorised reviewer must
  approve it.
- **Pay code / rate** opens **THIS TIMESHEET ONLY** corrections for
  payroll-authorised administrators. A reason is mandatory; employment rates
  are not changed. **Review breaks** shows recorded duration and missing,
  short or long planned-break discrepancies.
- Reports show count-only **Officer service evidence** with recorded,
  already-counted and additional records. This does not publish private officer
  narratives or unreviewed photos. After the supporting migration is released,
  regenerate monthly drafts to include the new supplement; issued packs and
  custom reports are not rewritten. **Recorded travel** is distance evidence,
  not a financial cost calculation.

### Section 3: Specialist Field Officer Portals (`officer`)
- On Home, **Install FCM on this phone** offers the browser installation prompt
  or home-screen instructions (Safari: Share, then Add to Home Screen).
  The installed shortcut uses the Iron Eagle icon. This is a PWA, not an APK or
  widget: it still needs connectivity for records and does not guarantee
  background GPS or lock-screen notifications.
- A static assignment links to its exact shift. Start/end the shift once;
  separate arrival/departure actions are not needed. If GPS or the site boundary
  cannot verify attendance, give an explanation for operations review.
- **Start break** becomes **Finish break**. A planned unpaid break shows its
  remaining allowance, recovered from the saved start after refresh. Finish it
  explicitly; payroll uses actual unpaid time. Finish an open break before
  ending the shift.
- In **Report**, save the report before attaching camera/gallery photos.
  Photos can also target an assigned incident. Check each upload confirmation
  and retry failures; saving the report alone does not confirm its photos.
  Original photos remain private evidence, not automatically client-published.
- The bottom field navigation provides **Home**, **Schedule**, **Tools**,
  **Report**, and **SOS**. The home page keeps the current assignment and
  personal safety visible; expand **More tools, open shifts and status** for
  additional actions. On the schedule, expand **Start an unscheduled shift**
  only when a supervisor has requested unscheduled work.
- The compact location control shows whether a current service place was
  resolved. Expand it for the detailed GPS/geofence state; a manually
  selected place is not proof of the officer's current position. Officers
  with both admin and field access can switch portals from account tools. On
  narrow screens, **More** contains instructions, Bob and change requests;
  notifications and account settings remain in the header.
- Navigation warns before discarding unfinished reports, debriefs or schedule
  entries; closing an unfinished end-shift dialog also
  asks for confirmation. These warnings do not save drafts. Submit work before
  leaving, especially when using the browser's Back or Forward controls.
- An unfinished shift remains in **Schedule** after its scheduled end. Choose
  **End shift** to record the debrief and finish once all work is complete.
  Briefing notes and individual stop names for these earlier shifts are
  withheld here; if stops or dispatch jobs remain open, contact operations
  to finish them.
- Debrief and shift end are separate confirmations. If a debrief response is
  unconfirmed, retry the same details or contact operations; if the debrief is
  recorded but the end is unconfirmed, check the shift status before retrying.
- **3.1 Freedom Camping:** Vehicle scans, SCV validation, overnight stays, breach notices, and evidence capture.
- **3.2 Parking Enforcement:** Plate lookup, chalking, time-limit rechecks, infringement notice drafting.
- **3.3 Noise Control:** Incident response, sound level assessment, EXC/END notice issuance.
- **3.4 Biosecurity Inspection:** Site inspections, risk rating, compliance checklists, and control orders.
- **3.5 Smoke Complaint Response:** Out-of-hours complaint triage, site visits, and field evidence logging.
- **3.6 Static Guarding & Patrols:** Checkpoint scans, route verification, site logbook entries, and hazard reporting.
- **3.7 Dispatch & Response:** Live PTT radio channels, job dispatch, callout response, and emergency alarm handling.
- **3.8 Welfare & Safety:** SOS panic trigger, periodic check-ins, man-down motion detection, and automated escalation.

### Section 4: Client Organisation Portals (`client_admin`, `client_officer`, `client_viewer`)
- Contracted site dashboards, live patrol coverage maps, breach/incident review, and client-portal reporting.

### Section 5: Public Portals (Unauthenticated / Public Access)
- Public dispute submission, pay-by-plate parking prepayment, noise complaint intake, parking appeals, camper self-registration.

---

## 4. Tracked Implementation & Issue Verification Matrix

To ensure systematic progress without losing context, every system section is mapped to a tracked implementation issue:

| Issue ID | Section Title | Target Scope | Status |
|---|---|---|---|
| `#FCM-001` | **Canonical Spine & Identity** | Organization, Place, Person, Vehicle, SCV normalization & RLS | **Active** |
| `#FCM-002` | **Geofence Map-Truth Engine** | `resolve_context_authorized`, spatial boundary verification, snap-to-site | **Active** |
| `#FCM-003` | **Module Subscription & Gating** | Independent vertical enablement, fail-closed `useEnabledModules` | **Active** |
| `#FCM-004` | **Officer Mobile Shell & Welfare** | Glove-safe UI, Night Patrol mode, SOS/Welfare monitoring, breadcrumbs | **Pending** |
| `#FCM-005` | **Freedom Camping Vertical** | ALPR scan, SCV checks, overnight verification, breach notices | **Pending** |
| `#FCM-006` | **Parking Enforcement Vertical** | Chalking, time limit tracking, infringement generation | **Pending** |
| `#FCM-007` | **Noise Control Vertical** | Sound level meter logging, notice drafting (EXC/END), dispatch response | **Pending** |
| `#FCM-008` | **Biosecurity & Smoke Vertical** | Inspection checklists, complaint triage, environmental logging | **Pending** |
| `#FCM-009` | **Static Guarding & Patrols** | Checkpoint NFC/QR scans, route tracking, site logbook | **Pending** |
| `#FCM-010` | **Dispatch Console & PTT** | Live job allocation, unit tracking, PTT radio channel integration | **Pending** |
| `#FCM-011` | **CRM, Rostering & HR** | Accounts, agreements, work units, roster planning, credentials | **Pending** |
| `#FCM-012` | **Operational Finance & Pay** | Work completion events, `dispatch_job_pay_lines`, rate engine, billing | **Pending** |
| `#FCM-013` | **Court-Ready Report Generator** | Provenance receipts, legal export, PDF evidence packets, audit chains | **Pending** |
| `#FCM-014` | **Bob Heuristic Field Copilot** | Portal-aware voice/panel assistant, hazard alerts, shift debriefs | **Pending** |
| `#FCM-015` | **Bob Owner Builder Studio** | Multi-media studio, isolated worker runner, control plane Gitea PR flow | **Pending** |

---

## 5. Governance & Change Control

1. **Instruction Manual as Source of Truth**: Any architectural or workflow change must update this manual in the exact same change set.
2. **Verification Before Completion**: No issue or task is marked completed without passing fresh unit/integration tests and app build checks.
3. **Bob Safe Execution Framework**: High-impact administrative mutations require explicit human review and approval gates.
