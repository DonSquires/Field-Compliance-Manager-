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
  Registration is fixed; shared canonical facts still require grand master
  review. Organisation notes are preserved. Identity/owner/VIN checks remain
  in their existing evidence-review workflow.
- Administrators can add or replace the shared vehicle profile photo using a
  JPEG, PNG or WebP up to 5 MB, preview it, and record a reason/source. The app
  resizes/re-encodes the image to remove embedded location metadata before
  upload. Do not include people or private surroundings. Photos use private
  storage and expiring links: another organisation only sees the photo through
  existing custody or caller-visible vehicle observation access. The picture
  is not public, identity proof, or enforcement evidence. Replacements retain
  previous photo receipts in audit history. If upload succeeds but linking
  fails, retry **Save profile photo** to reuse the uploaded file.
- In **Reports & Accountability > Repeat subject review**, choose **All
  authorised agreements and observations** to compare subjects across areas,
  including observations without an agreement mapping, or choose one agreement
  to narrow the review. The existing R&M administrator identity permission
  remains required; this is not a platform-wide disclosure option.
- Select **1 time (all subjects)** in either subject list to include subjects
  seen only once. Vehicle and verified-person lists use the selected period.
  Counts combine patrol sightings and accepted CCTV observations, not unreviewed
  detections or unlinked comment mentions. Open a subject to inspect its history,
  place and recorded officer context; comment mentions remain separate evidence
  requiring review.

---

## 3. System Section & Role Matrix

### Section 1: Platform Owner & Grand Master (`grand_master`, `master`)
- Multi-tenant setup, platform subscription terms, self-serve module catalog management, global capability inspection, and Bob Builder Studio governance.

### Section 2: Service Provider Administration (`admin`, `admin_officer`)
- Client portfolio management (CRM), service agreements, site/zone geofence management, workforce rostering, HR leave & credentials, and operational finance.

### Section 3: Specialist Field Officer Portals (`officer`)
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
