# Field Compliance Manager: Complete UI/UX Redesign Strategy

**Date:** 2026-09-12  
**Status:** Research & Design Phase  
**Scope:** Complete app-wide redesign (admin + field portals)  
**Priority:** Navigation shell + core workflows

---

## EXECUTIVE SUMMARY

Your current UI suffers from **backend-database-first design**, not **user-intent-first design**. The app displays every possible database field simultaneously, scatters actions across pages, and forces users through chaotic navigation to complete operational tasks.

**Target State:** A clean, whitespace-rich, card-based interface where users see only the critical metadata needed to make decisions *right now*, with secondary details hidden in progressive disclosure patterns.

---

## PHASE 1: CURRENT STATE AUDIT & PAIN POINTS

### Current Architecture Issues

| Problem Area | Symptom | Root Cause | Impact |
|---|---|---|---|
| **Navigation Shell** | Sidebar crammed with 15+ top-level items; no clear hierarchy | All modules listed flat; no grouping by user role or workflow | Users jump 3-4 times to complete a single task |
| **Page Layout** | Every input field, status badge, and metadata visible at once | Database-first schema (show all columns) | Cognitive overload; hard to see what matters |
| **Forms** | Dense form grids with 10+ fields without visual separation | No sectioning/progressive disclosure | Users get lost; don't know what to fill first |
| **Actions** | Buttons scattered throughout pages (top, bottom, inline) | No action ribbon or unified CTA design | Users miss key actions or click wrong buttons |
| **Master-Detail** | Clicking an item navigates away; back-button required | No split-view; single-column "all-or-nothing" layout | Operational context lost; inefficient task completion |
| **Visual Hierarchy** | All text sizes similar; gray-on-gray color scheme | No aggressive emphasis; flat design | Cannot scan page quickly; all information looks equally important |

### Audited Pages (Current Problems)

**FileSystemPage**  
- Problem: Shows 10+ file spaces, batch statuses, mapping rows, classifications all on one screen
- Data: 60+ visible fields (DocumentRow, IntakeAttachment, FileImportBatch types)
- User Goal: "Review and approve intake batches"  
- Current Path: Home → File System → Click batch → See raw batch details → Map columns manually → Approve
- Time to Task: ~5 clicks, 2+ page transitions

**AccountOnboardingPage**  
- Problem: Queue list on left, but if you select an item, the detail pane is crammed with status badges, dimensions, history, and actions
- Data: Ledger, dimensions (ready/blocked), assigned_to, stage_note, history events all visible
- User Goal: "Move account through onboarding stages"
- Current Path: Home → Onboarding → Click item → Read dense detail → Fill date → Update → Confirm stage transition
- Time to Task: ~6 clicks, state scattered across multiple regions

**AdminShell + Navigation**  
- Problem: Sidebar lists every admin function (CRM, Roster, Finance, Field Ops, Sites, Reports, etc.) flat; no role-based filtering
- User Goal: "Get to my most frequent workflow quickly"
- Current Path: Click sidebar → Navigate to module → Click sub-module → Load page
- Time to First Action: 2-3 clicks before anything operational happens

---

## PHASE 2: ENTERPRISE SAAS DESIGN PRINCIPLES (Research-Backed)

Based on industry leaders (Notion, Linear, Intercom, Airtable) and established frameworks (Nielsen Norman, IBM Enterprise Design Thinking, Baymard Institute):

### 1. **Progressive Disclosure** (Hide Secondary Data)
**Principle:** Only show data the user needs to decide in the first 2 seconds.  
**Pattern:** Critical metadata visible; secondary logs/details in:
- Expandable sections
- Slide-out drawer panels
- Hover details or tooltips
- Click-to-expand rows

**Example Application (FileSystemPage):**
```
[CRITICAL PATH - Always Visible]
File Name | Source | Status | Batch Date | Action
=========================================================

[SECONDARY - Hidden by Default]
├─ Click row → Slide-out drawer shows:
│  - Full file type breakdown
│  - Classification (PII/Security/Financial flags)
│  - Extraction confidence & OCR status
│  - Full audit log
│  - Map columns for batch
│  └─ Actions: Approve, Reject, Re-classify, Download
```

### 2. **Master-Detail Split View** (Keep Context Alive)
**Principle:** List/queue on left, detail panel on right; no back-button required.  
**Desktop Layout:** 30% queue | 70% detail panel (resizable)  
**Mobile Layout:** Tabs or swipeable sheets; queue list tab + detail tab

**Why It Works:**  
- User stays anchored in their working context
- Can compare multiple items without re-navigating
- Faster cognitive load than page-per-item pattern

**Example Application (AccountOnboardingPage):**
```
┌─────────────────────────────────────────────────────────┐
│ LEFT (30%)            │   RIGHT (70%)                   │
├───────────────────────┼─────────────────────────────────┤
│ Queue List:           │ Selected Item Detail:           │
│ ☐ Acme Corp [OVERDUE] │ Acme Corp                       │
│ ☐ Beta Ltd [IN REV]   │ Status: Configure               │
│ ☒ Gamma Inc [CONFIG]  │ Target Live: 2026-09-30         │
│ ☐ Delta SA [NEW]      │                                 │
│                       │ Readiness:                      │
│                       │ ✓ Primary Contact              │
│                       │ ✗ Site Activation              │
│                       │ ✓ Finance Connected            │
│                       │                                 │
│                       │ [Update] [Move to Review] [..] │
│                       │                                 │
│                       │ History (Expandable)            │
│                       │ ├─ 2026-09-10: Moved to Config │
│                       │ ├─ 2026-09-05: Contact Added   │
│                       │ └─ ...                          │
└───────────────────────┴─────────────────────────────────┘
```

### 3. **Visual Hierarchy via Whitespace & Cards** (De-Cluttering)
**Principle:** Generous padding (16px+), clear card boundaries, breathing room between sections.  
**Dark Theme Color Palette (Updated):**
- Background: `#07131b` (very dark blue-black)
- Card: `#0f1e2a` (raised, slightly lighter)
- Card Hover: `#152835` (interactive feedback)
- Primary Action: `#1a9876` (teal, high contrast)
- Secondary Action: `#4a6b7d` (muted blue)
- Danger Action: `#c7533a` (red, only for destructive)
- Text Primary: `#e8f0f3` (off-white)
- Text Secondary: `#8fa4ae` (muted blue-gray)
- Text Tertiary: `#6d7d89` (very muted)
- Accent (Success): `#2ecc71` (green)
- Accent (Warning): `#f39c12` (orange)
- Accent (Error): `#e74c3c` (red)

**Card Pattern:**
```
┌─────────────────────────────────────────────────────────┐
│ Card Header (compact, clear)                            │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Content with breathing room (16px padding)            │
│  ✓ Field 1: Value    ✓ Field 2: Value                 │
│                                                         │
│  More content...                                        │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ Card Footer (actions, secondary info)                  │
└─────────────────────────────────────────────────────────┘
```

### 4. **Action Ribbon / Contextual Actions** (Clear CTAs)
**Principle:** All primary actions for the current context in one place (sticky footer or top-right ribbon).  
**Pattern:** Save/Submit at bottom, Destructive actions clearly separated.

**Example (Onboarding Detail Panel):**
```
┌─────────────────────────────────────────────────────────┐
│ Acme Corp - Configuration                              │
│ ...content...                                           │
├─────────────────────────────────────────────────────────┤
│ [Update Metadata] [Move to Review →] [More ...]         │ ← Sticky Ribbon
└─────────────────────────────────────────────────────────┘
```

### 5. **Intent-Driven Navigation** (Workflow-First)
**Principle:** Organize sidebar by what users *do*, not by database entities.  
**Old (Database-First):**
```
Admin
├── CRM
├── Roster
├── Finance
├── File System
└── Reports
```

**New (Workflow-First, Role-Aware):**
```
Compliance Officer (Example Role)
├── 📋 Active Queue (incidents, approvals, tasks)
├── 📍 Map & Dispatch (field operations)
├── 👥 People & Rosters (staff availability)
├── 💰 Finance (billing, rates)
├── ⚙️ Configuration (sites, zones, rules)
└── ? Help & Support
```

---

## PHASE 3: SPECIFIC REDESIGNS (High-ROI Surfaces)

### 3.1 NAVIGATION SHELL REDESIGN

**Current State:**
```
┌─────────────────────────────────────────────────────────┐
│ [Admin Shell Header]                    [Notifications] │
├──────────────┬────────────────────────────────────────┤
│ Sidebar:     │ Active Page Content                     │
│ • Overview   │                                         │
│ • File Sys   │ (Dense, no structure)                  │
│ • Onboard    │                                         │
│ • Handsoff   │                                         │
│ • Roster     │                                         │
│ • Finance    │                                         │
│ • Field Ops  │                                         │
│ • Reports    │                                         │
│ • Sites      │                                         │
│ • Users      │                                         │
│ ... more ... │                                         │
└──────────────┴────────────────────────────────────────┘
```

**Proposed State (Master Navigation with Context Ribbon):**
```
┌─────────────────────────────────────────────────────────┐
│ [FCM Logo] [Breadcrumb / Context]    [Search] [Alerts] │
│ Compliance Officer > Active Tasks > Approval Queue     │
├──────────────┬────────────────────────────────────────┤
│ Navigation   │ Active Page Content (Clean, Spaced)   │
│ (Collapsed:  │                                        │
│  Icons + Top │ ✓ Master-Detail Split View            │
│  Category)   │ ✓ Cards with Breathing Room           │
│              │ ✓ Clear Action Ribbon                 │
│ ☰ Menu       │ ✓ Progressive Disclosure              │
│              │                                        │
│ ┌─ Daily    │ Expandable history/audit logs          │
│ ├─ Queue    │ (Not cluttering the main view)         │
│ ├─ Map      │                                        │
│ ├─ People   │                                        │
│ ├─ Finance  │                                        │
│ ├─ Config   │                                        │
│ └─ Help     │                                        │
└──────────────┴────────────────────────────────────────┘
```

**Navigation Architecture (New):**

```
PRIMARY NAVIGATION (Main Sidebar Sections)
├─ 🎯 My Daily Work (Smart Queue)
│  ├ Active Tasks (approvals, incidents, to-do)
│  ├ My Team's Status (quick staff view)
│  └ Alerts & Breaches
│
├─ 📍 Field Operations (Operational Map)
│  ├ Live Map & Dispatch Console
│  ├ Incident Reports & Evidence
│  ├ CCTV & Patrol Logs
│  └ Welfare & Safety
│
├─ 👥 People & Rosters (HR Spine)
│  ├ Staff Schedules
│  ├ Rostering Rules
│  ├ Access & Permissions
│  └ Performance & Training
│
├─ 💰 Finance & Billing (Finance Spine)
│  ├ Billing Rules & Rates
│  ├ Money & Accounts (ANZ/IRD)
│  ├ Invoicing & Reports
│  └ Cost Management
│
├─ 🏠 Sites & Places (Geographic Spine)
│  ├ Site Management
│  ├ Boundary & Zones
│  ├ Access Rules
│  └ Location Data
│
├─ 🤝 Organizations & CRM (Account Spine)
│  ├ Account Onboarding
│  ├ Client Portfolio (Agreements, Sites, Rosters)
│  ├ Activation Handoffs
│  └ Relationship Workspace
│
├─ 📊 Reports & Analytics
│  ├ Compliance Dashboard
│  ├ Operational Reports
│  ├ Financial Reports
│  └ Custom Views
│
├─ ⚙️ Configuration & Admin
│  ├ Organization Settings
│  ├ Users & Roles
│  ├ Approvals & Workflows
│  ├ System Tools
│  └ Platform Settings
│
└─ ❓ Help & Support
   ├ Documentation
   ├ Contact Support
   └─ Release Notes
```

**Benefits:**
- ✅ Workflow-first, not database-first
- ✅ User role determines what they see first
- ✅ Context ribbon (breadcrumb + current workflow) always visible
- ✅ Sub-categories folded under parent; less scrolling

---

### 3.2 FILE SYSTEM PAGE REDESIGN

**Current Problem:**  
- Shows 10+ file spaces, batches, classifications, mappings all at once
- User doesn't know where to start

**Proposed Design (Master-Detail with Progressive Disclosure):**

```
┌─────────────────────────────────────────────────────────┐
│ File System › Intake & Batches                          │
├──────────────────────┬─────────────────────────────────┤
│ QUEUE (30%)          │ DETAIL / ACTIONS (70%)          │
│                      │                                 │
│ Filter by Status:    │ Batch: "May Payroll 2026-09"   │
│ ☑ Needs Review (3)   │ ─────────────────────────────  │
│ ☐ Approved (5)       │                                 │
│ ☐ Applied (42)       │ 📊 Summary Card:               │
│ ☐ Failed (1)         │ ┌───────────────────────────┐  │
│                      │ │ Files: 156 | Bytes: 890MB │  │
│ Sort: Newest         │ │ Status: Needs Review      │  │
│                      │ │ Created: 2 days ago       │  │
│                      │ └───────────────────────────┘  │
│ ┌────────────────┐   │                                 │
│ │ May Payroll... │   │ 🔍 Schema Preview:              │
│ │ ✗ Needs Rev    │   │ ┌───────────────────────────┐  │
│ │ 3 days ago     │   │ │ Column Mapping:           │  │
│ └────────────────┘   │ │                           │  │
│                      │ │ Employee ID → emp_id ✓    │  │
│ ┌────────────────┐   │ │ First Name → first_name ✓ │  │
│ │ June HR Data   │   │ │ Salary → ??? UNRESOLVED   │  │
│ │ ✓ Applied      │   │ │ ...                       │  │
│ │ 1 week ago     │   │ └───────────────────────────┘  │
│ └────────────────┘   │                                 │
│                      │ [Details] [Map Columns] ...     │
│ ... more batches     │                                 │
│                      │ 📋 History (Expandable)         │
│                      │ ├─ 2026-09-10: Mapping Review  │
│                      │ └─ 2026-09-08: Uploaded        │
│                      │                                 │
│                      │ ─────────────────────────────  │
│                      │ [Review & Approve] [Reject]    │
│                      │                                 │
└──────────────────────┴─────────────────────────────────┘
```

**Key Changes:**
- Left queue: Shows only essential info (name, status, timestamp)
- Right detail: Summary card + schema preview (not raw CSV)
- Progressive disclosure: Details & history in expandable sections
- Actions: Bottom sticky ribbon (Approve, Reject, Map Columns)
- No page transitions needed to complete batch review

---

### 3.3 ACCOUNT ONBOARDING REDESIGN

**Current Problem:**  
- Dense detail pane with status badges, dimensions, stage note, history all crammed together
- User can't quickly see what's blocking progress

**Proposed Design (Dashboard-Style Card Layout):**

```
┌─────────────────────────────────────────────────────────┐
│ Account Onboarding › Qualification & Setup              │
├──────────────────────┬─────────────────────────────────┤
│ QUEUE (30%)          │ DETAIL DASHBOARD (70%)          │
│ Filter by Stage:     │                                 │
│ ☑ Qualify (2)        │ ┌─ Acme Corp ─────────────┐    │
│ ☑ Configure (1)      │ │ Status: Configuring     │    │
│ ☐ Review (3)         │ │ Target Live: 2026-09-30 │    │
│                      │ └─────────────────────────┘    │
│ ┌────────────────┐   │                                 │
│ │ Acme Corp      │   │ ┌─ Readiness Status ──────┐    │
│ │ 📌 OVERDUE     │   │ │ ✓ Primary Contact      │    │
│ │ Qual → Config  │   │ │ ✗ Site Activation     │    │
│ │ 45 days open   │   │ │   └─ Next: Invite mgr │    │
│ └────────────────┘   │ │ ✓ Billing Setup        │    │
│                      │ └────────────────────────┘    │
│ ┌────────────────┐   │                                 │
│ │ Beta Ltd       │   │ ┌─ Quick Actions ──────────┐   │
│ │ 🟢 IN REVIEW   │   │ │ [Add Site] [Invite]     │   │
│ │ Config → Rev   │   │ │ [Upload Docs] [Check]   │   │
│ │ 12 days open   │   │ └────────────────────────┘   │
│ └────────────────┘   │                                 │
│                      │ ┌─ Workflow History ────────┐   │
│ Sort: Overdue        │ │ ► Click to Expand:       │   │
│                      │ │   • 2026-09-10: Moved... │   │
│                      │ │   • 2026-09-05: Contact  │   │
│                      │ │   • ...                  │   │
│                      │ └────────────────────────┘   │
│                      │                                 │
│                      │ Target Live Date:               │
│                      │ [🗓 Date Picker]                │
│                      │                                 │
│                      │ Assigned To:                    │
│                      │ [Dropdown: Alice | Bob | ...]  │
│                      │                                 │
│                      │ Stage Note:                     │
│                      │ [Text Area - 3 lines max]      │
│                      │                                 │
│                      │ ─────────────────────────────  │
│                      │ [Update] [Move to Review →]    │ ← Sticky
│                      │ [More Options]                 │
│                      │                                 │
└──────────────────────┴─────────────────────────────────┘
```

**Key Changes:**
- Left queue: Compact cards showing status + priority visual (emoji or badge)
- Right detail: Dashboard-style cards (Status, Readiness, Actions, History)
- Readiness blocks are now clickable → shows next action, not just fail state
- Forms are grouped logically (not scattered)
- Sticky action ribbon at bottom (Update, Move Stage, More)
- History is collapsible (not always expanded)

---

### 3.4 OFFICER FIELD REPORT REDESIGN (Mobile/Tablet Focus)

**Current Problem:**  
- Dense form; user has to scroll through 15+ fields
- No clear "next step" guidance
- GPS/address capture feels disconnected from report flow

**Proposed Design (Step-Based Modal + Mobile-First):**

```
MOBILE VIEW (Tablet / Field Device):
┌─────────────────────────────────────┐
│ Field Report › New Submission        │
├─────────────────────────────────────┤
│                                     │
│ Step 1 of 4: Incident Basics        │ ← Clear Progress
│ ──────────────────────────────────   │
│                                     │
│ Report Type *                       │
│ [Dropdown: Incident | Maintenance] │
│                                     │
│ Severity *                          │
│ [Radio: Low | Medium | High | Crit] │
│                                     │
│ ─────────────────────────────────   │
│ [Back] [Next: Location →]           │
│                                     │
└─────────────────────────────────────┘

Step 2 of 4: Location & Evidence
──────────────────────────────────
Address / Location *
[Text Input + Resolve Button]
[🔵 GPS Captured: 2026-09-12 14:32:15]
[Use GPS] [Edit Manually]

Step 3 of 4: Details
──────────────────────────────────
Title *
[Text Input]

Description
[Text Area]

Related Shift (Optional)
[Dropdown: Patrol · 31 Aug | Site Guard · 2 Sept]

Step 4 of 4: Review & Submit
──────────────────────────────────
✓ Report Type: Incident
✓ Severity: High
✓ Location: [Address]
✓ GPS: [Coordinates]
Title: "..."
Description: "..."

[All Good? Submit Now →] [Go Back & Edit]
```

**Key Changes:**
- Multi-step wizard (4 steps, not 1 dense page)
- Progress indicator at top
- Each step shows only relevant fields
- GPS capture integrated into step 2 (not hidden)
- Mobile-friendly card layout
- Clear "Next" CTA, not scattered buttons
- Desktop view: Sidebar wizard + main detail panel (same content, different layout)

---

## PHASE 4: COMPONENT SPECIFICATIONS (Design System Updates)

### Typography
```css
/* Heading Styles */
.heading-xl { font-size: 28px; font-weight: 600; letter-spacing: -0.5px; }
.heading-lg { font-size: 22px; font-weight: 600; }
.heading-md { font-size: 18px; font-weight: 600; }
.heading-sm { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }

/* Body Styles */
.body-lg  { font-size: 16px; line-height: 1.5; } /* Primary content */
.body-md  { font-size: 14px; line-height: 1.5; } /* Standard text */
.body-sm  { font-size: 12px; line-height: 1.4; } /* Secondary labels */
.body-xs  { font-size: 11px; line-height: 1.4; } /* Tertiary, timestamps */

/* Minimum: 12px for all readable text; 11px only for tertiary/helper text */
```

### Spacing Scale
```css
--spacing-xs:  4px;
--spacing-sm:  8px;
--spacing-md:  16px;  /* Standard padding in cards */
--spacing-lg:  24px;  /* Between card sections */
--spacing-xl:  32px;  /* Between major sections */
--spacing-2xl: 48px;  /* Between major layout regions */
```

### Card Component Pattern
```css
.card {
  background: #0f1e2a;
  border: 1px solid #1c4353;
  border-radius: 8px;
  padding: var(--spacing-md);
  transition: border-color 200ms ease, background 200ms ease;
}

.card:hover {
  border-color: #2a5f7a;
  background: #152835;
}

.card--interactive {
  cursor: pointer;
}

.card--elevated {
  background: #152835;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--spacing-md);
  padding-bottom: var(--spacing-md);
  border-bottom: 1px solid #1c4353;
}

.card-body {
  display: grid;
  gap: var(--spacing-md);
}

.card-footer {
  display: flex;
  gap: var(--spacing-sm);
  margin-top: var(--spacing-md);
  padding-top: var(--spacing-md);
  border-top: 1px solid #1c4353;
  justify-content: flex-end;
}
```

### Status Badge / Pill Component
```css
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.badge--success  { background: #1a3a2e; color: #5eead4; }
.badge--warning  { background: #3d2d1f; color: #fbbf24; }
.badge--error    { background: #3a211f; color: #fca5a5; }
.badge--info     { background: #1f3449; color: #93c5fd; }
.badge--neutral  { background: #1c3a47; color: #9ca3af; }
```

### Master-Detail Layout
```css
.layout-master-detail {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: var(--spacing-md);
  height: 100%;
}

.layout-master-detail__master {
  overflow-y: auto;
  border-right: 1px solid #1c4353;
  padding: var(--spacing-md);
}

.layout-master-detail__detail {
  overflow-y: auto;
  padding: var(--spacing-md);
}

/* Mobile: Stack vertically */
@media (max-width: 1024px) {
  .layout-master-detail {
    grid-template-columns: 1fr;
    grid-template-rows: 240px 1fr;
  }

  .layout-master-detail__master {
    border-right: 0;
    border-bottom: 1px solid #1c4353;
  }
}
```

### Action Ribbon (Sticky Footer)
```css
.action-ribbon {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-md);
  border-top: 1px solid #1c4353;
  background: #0c1a24;
  z-index: 10;
  justify-content: flex-end;
}

.action-ribbon--primary {
  margin-right: auto;
  font-weight: 600;
}

.action-ribbon--destructive {
  color: #fca5a5;
  border-color: #7c4a4a;
}
```

---

## PHASE 5: IMPLEMENTATION ROADMAP

### Wave 1 (Weeks 1-2): Foundation
- [ ] Update CSS variable theme (colors, spacing, typography)
- [ ] Build new card component library + examples
- [ ] Refactor AdminShell navigation structure (intent-based grouping)
- [ ] Create master-detail layout wrapper component

### Wave 2 (Weeks 3-4): High-Impact Pages
- [ ] Redesign FileSystemPage (master-detail, card-based batches)
- [ ] Redesign AccountOnboardingPage (dashboard-style detail pane)
- [ ] Test with real users on 2-3 workflows

### Wave 3 (Weeks 5-6): Field Portal
- [ ] Redesign OfficerFieldReportPage (step-based wizard)
- [ ] Mobile tablet optimization
- [ ] GPS/address capture integration

### Wave 4 (Weeks 7-8): Polish & Scale
- [ ] Redesign remaining admin pages (using new patterns)
- [ ] Accessibility audit (keyboard nav, screen readers)
- [ ] Performance optimization (lazy loading, code splitting)

### Wave 5 (Week 9+): Continuous Improvement
- [ ] User testing & feedback
- [ ] A/B testing (old vs. new layouts)
- [ ] Iterate based on field user feedback

---

## PHASE 6: EXTERNAL RESEARCH RESOURCES

### Real-World SaaS Patterns (Study These)
1. **SaaSUI** (saasui.design) — 3,500+ real patterns from Notion, Linear, Intercom, Airtable
   - Study: Master-detail layouts, data tables, filters, onboarding flows
   - Relevant: File management, queue handling, batch operations

2. **Mobbin** (mobbin.com) — Real app UI flows
   - Study: Field apps, mobile reporting, incident management
   - Relevant: OfficerFieldReportPage, mobile UX

3. **Linear.app** — Exemplar of clean, dense data UI
   - Study: Queue management, kanban view, detail pane, sidebar navigation
   - Relevant: Account onboarding queue, dispatch console

4. **Notion** — Master of whitespace + progressive disclosure
   - Study: Card layouts, collapsible sections, minimal visual clutter
   - Relevant: File system batches, readiness dimensions

5. **Airtable** — Data-dense enterprise tool
   - Study: Table views, filtering, grouping, expanded row detail
   - Relevant: Batch review, mapping, record management

### Frameworks & Courses
- **Nielsen Norman NN/g**: "Designing Complex Apps for Specialized Domains" (enterprise software UX)
- **IBM Enterprise Design Thinking**: Free framework for B2B software design
- **Baymard Institute**: Research on advanced filtering, forms, error handling

### Design Systems to Reference
- **Ant Design** (ant.design) — Excellent for dense data UI, dark theme examples
- **Mantine** (mantine.dev) — React-first, great component library
- **Tailwind UI** (tailwindcss.com/plus/ui-blocks) — SaaS application templates

---

## SUCCESS METRICS

After redesign, we should measure:

- ✅ **Task Completion Time**: Reduce "Batch Review → Approval" from 5 clicks → 2-3 clicks
- ✅ **Error Rate**: Reduce form submission errors via progressive disclosure
- ✅ **User Satisfaction**: Increase SUS (System Usability Scale) score via post-launch survey
- ✅ **Accessibility**: Maintain WCAG AA compliance; add screen reader testing
- ✅ **Performance**: Keep page load < 2s; lazy-load detail panels
- ✅ **Adoption**: Field users complete more reports per shift (operational impact)

---

## NEXT STEPS

1. **Validate this strategy** with key users (compliance officer, field tech, admin)
2. **Pick ONE high-impact page** (recommend: FileSystemPage or AccountOnboardingPage)
3. **Build wireframes** (desktop + mobile) based on Phase 3 designs
4. **Create interactive prototype** using Figma or similar
5. **User test** with 3-5 target users
6. **Implement** based on feedback
7. **Scale** to remaining pages using proven patterns

---

## Questions to Answer Before Starting

1. **Which page hurts most operationally?** (Where do users spend most time / get frustrated?)
2. **How much time can we dedicate to redesign?** (Phased vs. all-at-once)
3. **Do we have design tools/resources?** (Figma, designer, user testing capability?)
4. **Can we do user testing?** (Real operator feedback vs. stakeholder feedback)
5. **Should the dark theme continue?** (It's working; let's keep it but improve spacing)

---

**End of Research & Strategy Document**

