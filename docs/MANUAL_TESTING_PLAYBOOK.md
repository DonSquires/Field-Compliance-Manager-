# Dr. Bob Manual Testing Playbook

## Overview

This playbook replaces automated snapshot tests with **human-style manual testing** — walking through pages as a real user would, observing visual/UX comfort and verifying that data actually flows end-to-end. It complements fixture-based unit tests and catches the real integration issues that code inspection misses.

## Testing Ethos

- **Look, not check:** Take screenshots, read visible text, notice cramping or unclear labels
- **Click and fill:** Actually use forms, hit buttons, watch for success/error messages
- **Data flow verification:** Does a field I edit actually persist? Does a related field update?
- **Cross-surface tracing:** If I update account A, do sites and agreements for A reflect it?
- **Color/contrast/ergonomics:** Is the UI suitable for long admin sessions?

## Test Categories

### 1. **CRM / Client Portfolio** (Critical: RLS + FK bugs known)
- Navigate account list → open account detail → view sites, agreements, contacts
- **Checkpoints:**
  - [ ] Account manager field shows a real person (not NULL) — **BLOCKS if RLS/FK fails**
  - [ ] Sites list with boundary status (verified/provisional)
  - [ ] Agreements with service modules visible
  - [ ] Contacts with primary contact marked
  - [ ] Activation handoff tasks visible and can be marked complete
- **Test file:** `crm-portfolio-manual-walkthrough.spec.ts` (already created)

### 2. **Welfare Alerts** (Critical: Missing writer for resolved_by, FK expansion RLS issue)
- Officer portal: navigate to alerts → acknowledge/resolve an alert
- Admin portal: view alert detail, see acknowledger and resolver fields
- **Checkpoints:**
  - [ ] Alert status displays correctly
  - [ ] Acknowledger field shows who acknowledged (if applicable)
  - [ ] Resolver field shows who resolved (if applicable) — **BLOCKS if writer missing**
  - [ ] Alert detail page doesn't crash with "Permission denied"
- **Data flow:** SOS triggered → escalates → officer acknowledges → field shows acknowledger name → admin resolves → field shows resolver name + timestamp
- **Test file:** `welfare-alerts-manual-walkthrough.spec.ts` (to create)

### 3. **Dispatch Jobs** (Critical: Missing SLA field writes)
- Create or view a dispatch job
- Check SLA fields: `sla_respond_by`, `sla_minutes`, `elapsed_minutes`
- **Checkpoints:**
  - [ ] SLA respond-by time is populated (not NULL) — **BLOCKS if trigger missing**
  - [ ] Elapsed time updates as time passes
  - [ ] Color coding for SLA status (e.g., red if breached)
- **Test file:** `dispatch-jobs-manual-walkthrough.spec.ts` (to create)

### 4. **Roster & HR** (Data persistence, state transitions)
- Navigate roster operations → create/edit shift
- Navigate HR page → check staff credentials, leave status
- **Checkpoints:**
  - [ ] Shift edit persists after reload
  - [ ] Credential expiry highlighted if expired
  - [ ] Leave status transitions properly
  - [ ] Coverage gaps are visible and claimable
- **Test file:** `roster-hr-manual-walkthrough.spec.ts` (to create)

### 5. **Field Operations & Geofence** (Map/boundary rendering)
- Navigate to operational place or geofence page
- Verify boundaries display on map
- Check zone rules and SCV exemptions
- **Checkpoints:**
  - [ ] Map renders and boundaries are visible
  - [ ] Zone rule (prohibited/restricted/unrestricted) is clear
  - [ ] SCV exemption checkbox logic is clear
  - [ ] Boundary source (authoritative/provisional) is noted
- **Test file:** `geofence-operations-manual-walkthrough.spec.ts` (to create)

### 6. **Officer Module Entitlements & Shells** (Navigation, role gating)
- Sign in as officer → verify only assigned modules are visible
- Sign in as admin → verify all admin surfaces available
- Try to navigate to a gated page (e.g., officer navigates to /admin) — should block
- **Checkpoints:**
  - [ ] Officer shell shows only patrol, freedom camping, parking (fixture example)
  - [ ] Admin shell shows CRM, HR, dispatch, finance, reporting
  - [ ] Unauthorized routes are redirected with clear message
  - [ ] Module names and icons are visually clear
- **Test file:** `shell-and-entitlements-manual-walkthrough.spec.ts` (to create)

---

## How to Run

### Single test
```bash
cd apps/web
npx playwright test e2e/crm-portfolio-manual-walkthrough.spec.ts
```

### All manual walkthrough tests
```bash
cd apps/web
npx playwright test e2e/*manual-walkthrough*.spec.ts
```

### View report
```bash
npx playwright show-report
```

---

## Interpreting Results

Each test is structured in **PHASES** that mirror real user actions:

1. **Navigation phase:** Can I find the page?
2. **Observation phase:** What content is visible? Are fields populated?
3. **Interaction phase:** Can I edit/submit? Does UI respond?
4. **Persistence phase:** Does data survive a reload?
5. **Integration phase:** Does related data update?

**Output example:**
```
✓ CRM link found and navigated
✓ Opened first client detail view
⚠ Account manager field is empty or shows placeholder — possible RLS/FK failure
✓ Sites section visible
✓ Map/boundary section visible
✓ Rates section visible
✓ Data persisted correctly
```

---

## Known Issues to Verify

| Issue | Test | Checkpoint |
|-------|------|------------|
| **Gap 1: welfare_alerts FK expansion fails RLS** | welfare-alerts-manual-walkthrough | Acknowledger/resolver fields visible |
| **Gap 2: dispatch_jobs SLA fields never written** | dispatch-jobs-manual-walkthrough | sla_respond_by is NOT NULL |
| **Gap 3: welfare_alerts.resolved_by never written** | welfare-alerts-manual-walkthrough | resolver field populated on resolve |
| **Gap 4: CrmPortfolioPage FK joins fail** | crm-portfolio-manual-walkthrough | Account manager field populated |
| **Gap 5: Quote→Agreement rates not synced** | crm-portfolio-manual-walkthrough | Rates section visible after agreement |
| **Gap 6: dispatch_jobs.dispatch_resource_id nullable** | dispatch-jobs-manual-walkthrough | Unassigned jobs handled gracefully |
| **Gap 7: officer_welfare_settings RLS missing** | welfare-alerts-manual-walkthrough | No "Permission denied" on welfare page |

---

## Screenshots & Assertions

Each phase includes:
- **Screenshot capture** (on-failure by default, can enable always)
- **Console logging** of what's visible (for CI review)
- **Soft assertions** (don't fail entire test, just report)

Example output saved to `playwright-report/` for visual inspection.

---

## Next Steps

1. **Create remaining manual walkthrough tests** (listed above under Test Categories #2–6)
2. **Run against live dev server** to catch UI/UX issues
3. **Run against CI** to detect data flow regressions
4. **Feed results to Bob** (via structured logging) for targeted fix recommendations
5. **Add Bob voice assertions** (optional): "Bob, read aloud the account manager field" to catch subtle rendering issues

---

## Design Philosophy

Unlike automated snapshot tests (brittle, hard to debug), manual walkthroughs:
- Document **what a human sees and does**
- Generate **actionable console logs** (easy to scan in CI)
- Detect **visual ergonomics issues** (cramping, contrast)
- Verify **data flow** not just UI structure
- Serve as **living documentation** of intended user journeys

Treat these tests as **lightweight acceptance tests**, not exhaustive coverage. They catch the 80% of issues that matter most: broken data flow, missing fields, and UX comfort.
