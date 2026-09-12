# UI/UX Redesign: Visual Mockups & Wireframes

**Status:** Design Reference  
**Use This To:** Visualize the new UI before building components

---

## MOCKUP 1: NEW ADMIN SHELL LAYOUT

### Desktop View (1440px)

```
╔════════════════════════════════════════════════════════════════════════════════╗
║  FCM Logo   Compliance Officer > Active Tasks > Approval Queue                 ║
║                                               [Search] [🔔 Alerts] [👤 Menu]   ║
╠═══════════════════════╦════════════════════════════════════════════════════════╣
║ NAVIGATION            ║ MAIN CONTENT AREA                                      ║
║ (Collapsed/Expanded)  ║                                                        ║
║ ☰ Admin Menu          ║ [Card 1: Status Overview]  [Card 2: Metrics]          ║
║                       ║ ────────────────────────────────────────────────────  ║
║ ┌─ 🎯 Daily Work      ║                                                        ║
║ │ ├─ Active Tasks   ✓ ║ [Card 3: Queue List]       [Card 4: Actions]          ║
║ │ ├─ Team Status      ║                                                        ║
║ │ └─ Alerts           ║ [Card 5: Recent Activity (expandable)]                ║
║ │                     ║                                                        ║
║ ┌─ 📍 Field Ops       ║ (Whitespace, breathing room between cards)            ║
║ │ ├─ Live Map       ║ (No horizontal scrolling, everything fits)              ║
║ │ ├─ Dispatch       ║                                                        ║
║ │ ├─ Incidents      ║                                                        ║
║ │ ├─ CCTV           ║                                                        ║
║ │ └─ Welfare        ║                                                        ║
║ │                     ║                                                        ║
║ ┌─ 👥 People         ║                                                        ║
║ │ ├─ Schedules      ║                                                        ║
║ │ ├─ Rules          ║                                                        ║
║ │ ├─ Access         ║                                                        ║
║ │ └─ Users          ║                                                        ║
║ │                     ║                                                        ║
║ ┌─ 💰 Finance        ║                                                        ║
║ │ ├─ Rates          ║                                                        ║
║ │ ├─ Money          ║                                                        ║
║ │ ├─ Invoicing      ║                                                        ║
║ │ └─ Costs          ║                                                        ║
║ │                     ║                                                        ║
║ ┌─ 🏠 Sites          ║                                                        ║
║ │ ├─ Management     ║                                                        ║
║ │ ├─ Boundaries     ║                                                        ║
║ │ ├─ Rules          ║                                                        ║
║ │ └─ Location Data  ║                                                        ║
║ │                     ║                                                        ║
║ ┌─ 🤝 Organizations  ║                                                        ║
║ │ ├─ Onboarding    ║                                                        ║
║ │ ├─ Portfolio      ║                                                        ║
║ │ ├─ Handoffs       ║                                                        ║
║ │ └─ Relationships  ║                                                        ║
║ │                     ║                                                        ║
║ ┌─ 📊 Reports        ║                                                        ║
║ │ ├─ Dashboard      ║                                                        ║
║ │ ├─ Operations     ║                                                        ║
║ │ └─ Financial      ║                                                        ║
║ │                     ║                                                        ║
║ ┌─ ⚙️ Configuration   ║                                                        ║
║ │ ├─ Settings       ║                                                        ║
║ │ ├─ Users & Roles  ║                                                        ║
║ │ ├─ Approvals      ║                                                        ║
║ │ └─ System         ║                                                        ║
║ │                     ║                                                        ║
║ └─ ❓ Help           ║                                                        ║
║   ├─ Docs           ║                                                        ║
║   ├─ Support        ║                                                        ║
║   └─ Release Notes  ║                                                        ║
║                       ║                                                        ║
╚═══════════════════════╩════════════════════════════════════════════════════════╝
```

**Key Changes:**
- ✅ Workflow-first nav (not database-first)
- ✅ Related items grouped under parent categories
- ✅ Breadcrumb shows current location clearly
- ✅ Main content has breathing room (generous margins)
- ✅ Cards are the primary UI unit (not scattered fields)

---

## MOCKUP 2: FILE SYSTEM PAGE (Master-Detail Redesign)

### Current Mess → Proposed Clean Layout

**BEFORE (Current - Dense, Overwhelming):**
```
┌──────────────────────────────────────────────────────────────────────┐
│ File System                                                          │
├──────────────────────────────────────────────────────────────────────┤
│ [Upload] [Create Batch] [Review Batch] [Download] [Settings]        │
│                                                                      │
│ File Spaces: [All ▼] Filter: [All ▼] Sort: [Newest ▼]              │
│                                                                      │
│ ┌─ Batch 1: "May Payroll"        Status: Needs Review              │
│ │ Files: 156 | Bytes: 890MB | Created: 2026-09-10 14:32 | ...      │
│ │ [SHOW MAPPING] [APPROVE] [REJECT] [DELETE]                        │
│ │                                                                    │
│ │ Column Mappings: (inline, not expandable)                         │
│ │ Employee ID → emp_id (confidence: 99%)                            │
│ │ First Name → first_name (confidence: 95%)                         │
│ │ Salary → ??? (UNRESOLVED) [RESOLVE] [SKIP]                       │
│ │ Department → ??? (UNRESOLVED) [RESOLVE] [SKIP]                   │
│ │ ... 10 more column mappings ...                                   │
│ │                                                                    │
│ │ Classification: PII (Contains: SSN, Salary) | Confidence: 98%     │
│ │ OCR Required: 3 pages | Extraction Status: 78% complete           │
│ │ Audit Log: [Click to expand] 25+ events                           │
│ │                                                                    │
│ └─────────────────────────────────────────────────────────────────  │
│                                                                      │
│ ┌─ Batch 2: "June HR Data"       Status: Applied                    │
│ │ [Same dense layout repeats for each batch]                        │
│ │                                                                    │
│ └─────────────────────────────────────────────────────────────────  │
│                                                                      │
│ [Pagination: 1 2 3 4 5] [Load More]                                │
└──────────────────────────────────────────────────────────────────────┘

Problems:
❌ Everything visible at once = cognitive overload
❌ Have to scroll massively to see next batch
❌ Column mappings are not scannable (10+ lines per batch)
❌ Actions scattered (top buttons + inline buttons)
❌ No clear visual hierarchy
❌ Can't compare batches side-by-side
```

**AFTER (Proposed - Clean, Scannable, Master-Detail):**
```
┌──────────────────────────────────────────┬────────────────────────────────────┐
│ BATCH QUEUE (30%)                        │ BATCH DETAIL & ACTIONS (70%)       │
├──────────────────────────────────────────┼────────────────────────────────────┤
│ Filters:                                 │ ┌─ Batch: "May Payroll" ──────────┐
│ ☑ Needs Review (3)                       │ │ Status: Needs Review             │
│ ☐ Approved (5)                           │ │ Created: 2026-09-10 14:32        │
│ ☐ Applied (42)                           │ └──────────────────────────────────┘
│ ☐ Failed (1)                             │
│                                          │ ┌─ Summary ──────────────────────────┐
│ Sort: [Newest ▼]                         │ │ Files: 156      │ Bytes: 890 MB   │
│ [Reset Filters]                          │ │ Source: Email   │ Type: CSV       │
│                                          │ │ Rows: 4,203     │ Duplicates: 12  │
│ ┌────────────────────────────────────┐   │ └────────────────────────────────────┘
│ │ ┌─ May Payroll ────────────────────┐   │
│ │ │ 📄 CSV                           │   │ ┌─ Schema Preview ──────────────────┐
│ │ │ 📌 NEEDS REVIEW                  │   │ │ Column Mappings:                 │
│ │ │ Files: 156                       │   │ │ ✓ Employee ID → emp_id (99%)    │
│ │ │ 2 days ago                       │   │ │ ✓ First Name → first_name (95%)  │
│ │ │ [Click to select] →              │   │ │ ✗ Salary → ??? UNRESOLVED       │
│ │ └─────────────────────────────────┘   │ │ ✗ Department → ??? UNRESOLVED   │
│ │                                        │ │ [Expand: Show all 12 mappings]   │
│ ├────────────────────────────────────┤   │ └────────────────────────────────────┘
│ │ ┌─ June HR Data ────────────────────┐   │
│ │ │ 📄 XLSX                          │   │ ┌─ Classification & Warnings ──────┐
│ │ │ ✓ APPLIED                        │   │ │ PII Detected: SSN, Salary       │
│ │ │ Files: 89                        │   │ │ Confidence: 98%                 │
│ │ │ 1 week ago                       │   │ │ OCR: 3 pages required           │
│ │ │ [Click to select]                │   │ │ Extraction Progress: 78% ✓      │
│ │ └─────────────────────────────────┘   │ └────────────────────────────────────┘
│ │                                        │
│ ├────────────────────────────────────┤   │ ┌─ History (Expandable) ───────────┐
│ │ ┌─ August Roster ────────────────────┐   │ │ ► 2026-09-10 14:32               │
│ │ │ 📄 JSON                          │   │ │   Mapping Review: Completed      │
│ │ │ 🟡 NEEDS REVIEW                  │   │ │                                 │
│ │ │ Files: 203                       │   │ │ ► 2026-09-08 09:15               │
│ │ │ 4 days ago                       │   │ │   Uploaded by: alice@fcm.co.nz  │
│ │ │ [Click to select]                │   │ │                                 │
│ │ └─────────────────────────────────┘   │ │ [Show all 12 events]             │
│ │                                        │ └────────────────────────────────────┘
│ ├────────────────────────────────────┤   │
│ │ [More batches...] (4 more)         │   │ ┌─ Actions ───────────────────────┐
│ │                                        │ │ [Review & Approve] [Reject]     │
│ └────────────────────────────────────┘   │ │ [Re-run Mapping] [View Raw CSV] │
│                                          │ │ [Download Report] [More ...]    │
│                                          │ └────────────────────────────────┘
│                                          │
│                                          │ (Sticky footer when scrolling)
│                                          │ ──────────────────────────────────
│                                          │ [Review & Approve] [Reject]
│                                          │
└──────────────────────────────────────────┴────────────────────────────────────┘

Benefits:
✅ Queue is scannable (only name, status, date per item)
✅ Detail pane is clean, card-based, breathing room
✅ Progressive disclosure: click "Expand" to see full mappings
✅ Actions in one place (sticky ribbon at bottom)
✅ Easily compare batches by clicking different items in queue
✅ No page transitions needed
✅ Visual hierarchy is crystal clear
```

---

## MOCKUP 3: ACCOUNT ONBOARDING PAGE (Dashboard-Style)

### Current Dense → Proposed Clean

**BEFORE (Current - Dense Detail Pane):**
```
┌──────────────────────────────────────────────────────────────────────┐
│ Account Onboarding › Setup Queue                                    │
├──────────────────────────────────────────────────────────────────────┤
│ Queue:                                                               │
│ ┌─ Acme Corp (selected)                                              │
│ │ Status: Configuring | Assigned: Alice | Target Live: 2026-09-30   │
│ │ Days Open: 45 | Overdue: Yes | Version: 5                         │
│ │                                                                    │
│ │ Readiness:                                                         │
│ │ ✓ Primary Contact Added                                           │
│ │ ✗ Site Activation: BLOCKED (Next: Invite site manager)           │
│ │ ✓ Billing Setup: READY                                            │
│ │ ✓ Agreement Signed                                                │
│ │                                                                    │
│ │ Stage Details:                                                     │
│ │ Current Stage: Configure                                          │
│ │ Target Live Date: 2026-09-30 [Date Picker]                        │
│ │ Workflow Owner: [Dropdown: Alice | Bob | Charlie]                 │
│ │ Stage Note: [Text area]                                           │
│ │                                                                    │
│ │ History: (Raw event log, hard to scan)                            │
│ │ 2026-09-10 14:32 Stage Changed: Qualify → Configure by Alice      │
│ │ 2026-09-10 13:15 Primary Contact Added by Bob                     │
│ │ 2026-09-08 09:00 Account Created by System                        │
│ │ 2026-09-05 16:45 Initial Assessment: Ready by Charlie             │
│ │                                                                    │
│ │ [Update Metadata] [Move to Review] [Create Account] [More] [...]  │
│ └────────────────────────────────────────────────────────────────   │
│                                                                      │
│ ┌─ Beta Ltd (not selected)                                           │
│ │ Status: Review | ...                                              │
│ │ (Dense display repeats for each queue item)                       │
│ │                                                                    │
│ └────────────────────────────────────────────────────────────────   │

Problems:
❌ Readiness items are listed but not actionable (what's the next step?)
❌ All information visible at once = cognitive overload
❌ Forms scattered (Target Live, Workflow Owner, Stage Note)
❌ History is unformatted event log, hard to scan
❌ Actions crammed at bottom with no visual prominence
❌ No clear "what's blocking progress?"
```

**AFTER (Proposed - Dashboard Cards):**
```
┌──────────────────────────────────────────┬────────────────────────────────────┐
│ QUEUE (30%)                              │ DETAIL DASHBOARD (70%)             │
├──────────────────────────────────────────┼────────────────────────────────────┤
│ Filters by Stage:                        │ ┌─ Acme Corp - Configuration ──────┐
│ ☑ Qualify (2)                            │ │ Status: Configuring              │
│ ☑ Configure (1)                          │ │ Days Open: 45 👉 OVERDUE         │
│ ☐ Review (3)                             │ │ Target Live: 2026-09-30          │
│ ☐ Applied (0)                            │ └──────────────────────────────────┘
│                                          │
│ Sort: [Overdue First ▼]                  │ ┌─ Readiness Status ───────────────┐
│                                          │ │ ✓ Primary Contact Added          │
│ ┌────────────────────────────────────┐   │ │ ✗ Site Activation                │
│ │ ┌─ Acme Corp ──────────────────────┐   │ │   └─ Next Step: Invite Manager  │
│ │ │ 📌 OVERDUE (45 days)             │   │ │   └─ [Invite Now →]              │
│ │ │ Qual → Config                    │   │ │ ✓ Billing Setup                  │
│ │ │ Assigned: Alice                  │   │ │ ✓ Agreement Signed               │
│ │ │ [Click to select] →              │   │ └──────────────────────────────────┘
│ │ └─────────────────────────────────┘   │
│ │                                        │ ┌─ Quick Actions ──────────────────┐
│ ├────────────────────────────────────┤   │ │ [Invite Site Manager]            │
│ │ ┌─ Beta Ltd ───────────────────────┐   │ │ [Upload Activation Docs]         │
│ │ │ ✓ IN REVIEW (12 days)            │   │ │ [Send to Stakeholder Review]     │
│ │ │ Config → Review                  │   │ │ [Check Dependencies]             │
│ │ │ Assigned: Bob                    │   │ └──────────────────────────────────┘
│ │ │ [Click to select]                │   │
│ │ └─────────────────────────────────┘   │ ┌─ Workflow Configuration ─────────┐
│ │                                        │ │ Target Live Date:                 │
│ ├────────────────────────────────────┤   │ │ [🗓 2026-09-30]                   │
│ │ ┌─ Gamma Inc ──────────────────────┐   │ │                                   │
│ │ │ 🟡 NEEDS REVIEW (8 days)         │   │ │ Assigned To:                      │
│ │ │ Config (blocked)                 │   │ │ [Dropdown: Alice | Bob | Charlie] │
│ │ │ Assigned: Charlie                │   │ │                                   │
│ │ │ [Click to select]                │   │ │ Stage Note:                       │
│ │ │                                  │   │ │ [Text area, 3 lines]              │
│ │ └─────────────────────────────────┘   │ │                                   │
│ │                                        │ └──────────────────────────────────┘
│ │                                        │
│ └────────────────────────────────────┘   │ ┌─ Workflow History ────────────────┐
│                                          │ │ ► 2026-09-10: Qual → Configure    │
│                                          │ │   by Alice (Move reason: ...)      │
│                                          │ │                                   │
│                                          │ │ ► 2026-09-08: Contact Added       │
│                                          │ │   by Bob                          │
│                                          │ │                                   │
│                                          │ │ [Show all events]                 │
│                                          │ └──────────────────────────────────┘
│                                          │
│                                          │ ──────────────────────────────────
│                                          │ [Update] [Move to Review →]
│                                          │ [More Options]
│                                          │
└──────────────────────────────────────────┴────────────────────────────────────┘

Benefits:
✅ Queue shows status with emoji (easy to scan for overdue)
✅ Readiness has "Next Step" action attached (not just failure state)
✅ Dashboard cards are clear: Status | Readiness | Quick Actions | Forms | History
✅ Forms are grouped logically (Workflow Configuration section)
✅ History is collapsible and formatted readably
✅ Primary actions in sticky ribbon (Update, Move to Review)
✅ Urgency communicated visually (overdue badge, emoji)
```

---

## MOCKUP 4: OFFICER FIELD REPORT (Mobile Wizard)

### Current Dense Form → Proposed Step-Based

**BEFORE (Current - 1 Dense Page):**
```
┌─────────────────────────────────────────┐
│ Field Report › New Submission            │
├─────────────────────────────────────────┤
│                                         │
│ Report Type * [Dropdown ▼]             │
│ [Incident | Maintenance | Health]      │
│                                         │
│ Severity * [Radio:  Low Medium High]   │
│                                         │
│ Title * [Text Input]                   │
│                                         │
│ Description [Textarea]                 │
│                                         │
│ Location Name [Text Input]             │
│                                         │
│ Address [Text Input] [Resolve ➜]       │
│                                         │
│ GPS [Status: Not Captured] [Capture ➜] │
│                                         │
│ Related Shift [Dropdown]                │
│                                         │
│ Immediate Action Required [Checkbox]   │
│                                         │
│ Follow-up Notes [Textarea]              │
│                                         │
│ Mark as Follow-up [Checkbox]            │
│                                         │
│ Attachments:                            │
│ [Add Photo] [Add Video] [Add Document] │
│                                         │
│ [Submit] [Cancel] [Save Draft]          │
│                                         │
└─────────────────────────────────────────┘

Problems:
❌ Mobile: User has to scroll 50+ pixels to see all fields
❌ No guidance on what to fill first
❌ GPS capture is hidden among other fields
❌ Too many options at once
❌ Location/address fields scattered
❌ At submission, no review step
```

**AFTER (Proposed - Multi-Step Wizard):**
```
┌─────────────────────────────────────────────────────────────┐
│ Field Report › Incident Submission        [1 of 4: Basics]   │ ← Progress
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ 🎯 INCIDENT BASICS                                          │
│                                                             │
│ Report Type *                                              │
│ [Incident | Maintenance | Health & Safety]                │
│                                                             │
│ Severity *                                                 │
│ ◉ Low   ○ Medium   ○ High   ○ Critical                    │
│                                                             │
│                                                             │
│ ──────────────────────────────────────────────────────────  │
│ [Back] [Next: Location →]                                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘

[Click Next →]

┌─────────────────────────────────────────────────────────────┐
│ Field Report › Incident Submission    [2 of 4: Location]    │ ← Progress
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ 📍 LOCATION & EVIDENCE                                      │
│                                                             │
│ Address *                                                  │
│ [Text input]                                               │
│ [Resolve from map]                                         │
│                                                             │
│ GPS Capture                                                │
│ [🟢 Captured at 2026-09-12 14:32:15]                       │
│ Coordinates: -41.2865, 174.7762                            │
│ [Use This] [Retake GPS]                                    │
│                                                             │
│ Location Notes                                             │
│ [Text area]                                                │
│                                                             │
│                                                             │
│ ──────────────────────────────────────────────────────────  │
│ [Back] [Next: Details →]                                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘

[Click Next →]

┌─────────────────────────────────────────────────────────────┐
│ Field Report › Incident Submission    [3 of 4: Details]     │ ← Progress
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ 📝 INCIDENT DETAILS                                        │
│                                                             │
│ Title *                                                    │
│ [Text input, 1 line]                                       │
│                                                             │
│ Description                                                │
│ [Textarea, 5 lines]                                        │
│                                                             │
│ Related Shift (Optional)                                   │
│ [Dropdown: Patrol · 31 Aug | Site Guard · 2 Sept]         │
│                                                             │
│ Immediate Action Required?                                 │
│ ☐ Yes, this needs urgent follow-up                        │
│                                                             │
│ Follow-up Notes                                            │
│ [Textarea]                                                 │
│                                                             │
│                                                             │
│ ──────────────────────────────────────────────────────────  │
│ [Back] [Next: Review →]                                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘

[Click Next →]

┌─────────────────────────────────────────────────────────────┐
│ Field Report › Incident Submission  [4 of 4: Review]        │ ← Progress
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ ✓ REVIEW & SUBMIT                                          │
│                                                             │
│ ┌─ Incident Basics ────────────────────────────────────┐   │
│ │ Type: Incident                                      │   │
│ │ Severity: High                                      │   │
│ └─────────────────────────────────────────────────────┘   │
│                                                             │
│ ┌─ Location ───────────────────────────────────────────┐   │
│ │ Address: 123 Main St, Auckland                      │   │
│ │ GPS: -41.2865, 174.7762                             │   │
│ │ [Map Preview]                                       │   │
│ └─────────────────────────────────────────────────────┘   │
│                                                             │
│ ┌─ Details ────────────────────────────────────────────┐   │
│ │ Title: Unauthorized Vehicle in Lot                  │   │
│ │ Description: Silver sedan, license ending in XYZ... │   │
│ │ Related Shift: Patrol · 31 Aug                      │   │
│ │ Follow-up: Yes                                      │   │
│ └─────────────────────────────────────────────────────┘   │
│                                                             │
│ [Edit] [Go Back & Change]                                 │
│                                                             │
│ ──────────────────────────────────────────────────────────  │
│ [Cancel] [Submit Report] [Save as Draft]                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘

Benefits:
✅ Step-based: User knows exactly where they are (1 of 4)
✅ Mobile-friendly: No massive scrolling
✅ GPS capture is centered in its own step (clear importance)
✅ Review step prevents submission errors
✅ Clear "Next" CTAs, not scattered buttons
✅ Field validation clear at each step
✅ Looks great on both mobile (portrait) and tablet (landscape)
```

---

## MOCKUP 5: COLOR & SPACING REFERENCE

### New Color Palette (Dark Theme)

```
BACKGROUNDS:
┌─────────────────────────────────────────────────────────────┐
│ #07131b (Primary)       Very dark blue-black               │
│ ██████████████████████████████████                          │
│                                                             │
│ #0c1a24 (Secondary)     Dark blue, nested backgrounds      │
│ ████████████████████████████                               │
│                                                             │
│ #0f1e2a (Card)          Slightly raised                    │
│ ███████████████████████████                                │
│                                                             │
│ #152835 (Raised/Hover)  Elevated state                     │
│ ██████████████████████████                                 │
└─────────────────────────────────────────────────────────────┘

TEXT COLORS:
┌─────────────────────────────────────────────────────────────┐
│ #e8f0f3 (Primary Text)  Off-white, main content            │
│ ████████████████████████████████████████████████████ ← Readable
│                                                             │
│ #8fa4ae (Secondary)     Muted blue-gray, labels            │
│ ████████████████████████████ ← Good for secondary info     │
│                                                             │
│ #6d7d89 (Tertiary)      Very muted, timestamps             │
│ ████████████████ ← Tertiary only                           │
└─────────────────────────────────────────────────────────────┘

SEMANTIC COLORS:
┌─────────────────────────────────────────────────────────────┐
│ ✓ SUCCESS (#2ecc71)                                        │
│ ████████████ Green (high contrast, readable)               │
│                                                             │
│ ⚠ WARNING (#f39c12)                                        │
│ ███████████████ Orange (caution, clear)                    │
│                                                             │
│ ✗ ERROR (#e74c3c)                                          │
│ ███████████ Red (destructive actions)                      │
│                                                             │
│ ℹ INFO (#3498db)                                           │
│ ████████████ Blue (informational)                          │
│                                                             │
│ → PRIMARY ACTION (#1a9876)                                 │
│ ████████████ Teal (main CTAs)                              │
└─────────────────────────────────────────────────────────────┘

SPACING SCALE VISUAL:
┌─────────────────────────────────────────────────────────────┐
│ xs (4px)      ▮ Minimal                                     │
│ sm (8px)      ▮▮ Button padding, icon gaps                 │
│ md (16px)     ▮▮▮▮ Card padding, section gaps              │
│ lg (24px)     ▮▮▮▮▮▮▮ Between card sections                │
│ xl (32px)     ▮▮▮▮▮▮▮▮▮ Between major sections             │
│ 2xl (48px)    ▮▮▮▮▮▮▮▮▮▮▮▮ Between layout regions          │
└─────────────────────────────────────────────────────────────┘
```

### Typography Hierarchy

```
┌─────────────────────────────────────────────────────────────┐
│ Page Heading (28px, Bold)                                  │
│ The Largest Text - Used Sparingly                          │
│                                                             │
│ Section Heading (22px, Bold)                               │
│ Still prominent, breaks up major sections                  │
│                                                             │
│ Card Header (18px, Bold)                                   │
│ Inside card / detail pane headers                          │
│                                                             │
│ Subheading (14px, Bold, Uppercase)                         │
│ LABELS AND CATEGORY HEADERS                                │
│                                                             │
│ Body Text (14px, Regular)                                  │
│ Primary content, form labels, descriptions                │
│ This is the most common text size in the app              │
│                                                             │
│ Secondary Text (12px, Regular)                             │
│ Timestamps, helper text, secondary info                   │
│ Still easily readable                                      │
│                                                             │
│ Tertiary Text (11px, Regular)                              │
│ SMALL CAPS, BADGES, TIMESTAMPS                             │
│ Minimum readable size, use sparingly                       │
└─────────────────────────────────────────────────────────────┘
```

---

## IMPLEMENTATION CHECKLIST

Use this to track progress as you build:

```
PHASE 1: FOUNDATION (Week 1-2)
─────────────────────────────────────────────────────────────
☐ Create theme-tokens.css (colors, spacing, typography)
☐ Build Card component (with variants)
☐ Build Badge component
☐ Build ActionRibbon component
☐ Build MasterDetailLayout component
☐ Update global CSS with new spacing/colors

PHASE 2: SHELL & NAVIGATION (Week 3)
─────────────────────────────────────────────────────────────
☐ Refactor AdminShell navigation (intent-based grouping)
☐ Add breadcrumb context ribbon
☐ Update sidebar styling (use new colors, spacing)
☐ Mobile responsive navigation (hamburger menu)
☐ Test keyboard navigation

PHASE 3: HIGH-IMPACT PAGE - FILE SYSTEM (Week 4)
─────────────────────────────────────────────────────────────
☐ Wrap FileSystemPage in MasterDetailLayout
☐ Create BatchQueue (left panel, card-based items)
☐ Create BatchDetail (right panel, cards for summary/schema/history)
☐ Create ActionRibbon for batch actions
☐ Implement progressive disclosure (expandable sections)
☐ Test on desktop + mobile

PHASE 4: HIGH-IMPACT PAGE - ONBOARDING (Week 5)
─────────────────────────────────────────────────────────────
☐ Wrap AccountOnboardingPage in MasterDetailLayout
☐ Create OnboardingQueue (left panel)
☐ Refactor detail pane as dashboard (Status | Readiness | Actions | Forms | History)
☐ Add quick action cards ("Invite Manager", "Upload Docs", etc.)
☐ Create ActionRibbon for workflow actions
☐ Test on real users

PHASE 5: FIELD REPORT WIZARD (Week 6)
─────────────────────────────────────────────────────────────
☐ Create StepBasedWizard component
☐ Build 4-step workflow (Basics | Location | Details | Review)
☐ GPS capture in step 2
☐ Review/summary in step 4
☐ Mobile-first responsive design
☐ Test on tablet/field devices

PHASE 6: POLISH & SCALE (Week 7-8)
─────────────────────────────────────────────────────────────
☐ Accessibility audit (keyboard nav, screen readers)
☐ Performance optimization (lazy load, code splitting)
☐ Apply patterns to remaining pages (Admin Hub, Reports, etc.)
☐ User testing with real operators
☐ A/B testing (old vs. new layouts) if needed
☐ Documentation + style guide

CONTINUOUS
─────────────────────────────────────────────────────────────
☐ Gather feedback from field users
☐ Iterate based on findings
☐ Measure task completion time improvements
☐ Monitor error rates (form submissions, navigation)
```

---

**Now go build! Start with the foundation (theme tokens + components), then tackle FileSystemPage or AccountOnboardingPage as your first real page redesign. Use these mockups as your visual reference.**

