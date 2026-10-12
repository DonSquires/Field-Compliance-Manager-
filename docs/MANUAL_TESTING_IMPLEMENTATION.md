# Dr. Bob Manual Testing System — Implementation Summary

**Date:** 2026-09-09  
**Objective:** Replace brittle snapshot testing with human-style manual walkthroughs that catch UI/UX and data flow issues  
**Status:** ✅ COMPLETE — 3 focused e2e tests + strategic playbook

---

## What We Built

### 1. **Strategic Playbook** (`docs/MANUAL_TESTING_PLAYBOOK.md`)
- 6-category testing framework aligned with critical gaps (CRM, Welfare, Dispatch, Roster, Field Ops, Shells)
- Each category documents real user journeys and data flow checkpoints
- Clear output interpretation guide for CI/developer review
- Targets all 8 critical implementation gaps identified in September audit

### 2. **Three Focused Manual Walkthrough Tests**

#### **CRM Portfolio Manual Walkthrough** (`crm-portfolio-manual-walkthrough.spec.ts`)
- 10-phase human-style journey: Sign in → List → Detail → Sites → Agreements → Contacts → Handoff → UX check → Data persistence
- **Targets:** Gap 1 (account manager FK expansion RLS), Gap 5 (quote→agreement rates sync)
- **Key assertions:** Account manager field populated, site boundaries visible, rates section wired
- **Output:** Console logs showing "✓ Site detail loaded" or "⚠⚠⚠ Account manager NULL — RLS failure"

#### **Welfare Alerts Manual Walkthrough** (`welfare-alerts-manual-walkthrough.spec.ts`)
- 9-phase journey: Navigate → List → Open → Acknowledge → Resolve → Verify resolver field → Officer view → Performance → Persistence
- **Targets:** Gap 1 (FK expansion RLS), Gap 3 (resolved_by/resolved_at never written), Gap 7 (RLS missing)
- **Critical tests:**
  - "Acknowledger field visible: …" (FK expansion works)
  - "Resolver field populated after resolve" (data writer works)
  - No "Permission denied" errors (RLS policy exists)
- **Output:** Detects NULL resolvers (Gap 3), permission failures (Gap 1)

#### **Dispatch Jobs Manual Walkthrough** (`dispatch-jobs-manual-walkthrough.spec.ts`)
- 9-phase journey: Navigate → List → Detail SLA fields → Check resource assignment → Try assign → Status change → Performance → Breach scenario → Persistence
- **Targets:** Gap 2 (SLA fields never written), Gap 6 (NULL dispatch_resource_id)
- **Critical tests:**
  - `sla_respond_by` is populated (trigger writes it)
  - `sla_minutes` shows window
  - Unassigned jobs show "Unassigned" (not NULL)
  - Breach status shows red color
- **Output:** "⚠⚠⚠ CRITICAL: sla_respond_by is NULL — trigger not writing field! (Gap 2)"

---

## Key Design Philosophy

### Unlike Snapshot Tests:
- ❌ Brittle image diffs (one pixel change breaks)
- ❌ No visibility into WHY test fails
- ❌ Hard to understand test intent

### Manual Walkthroughs:
- ✅ **Console logs** that read like a human user's walkthrough
- ✅ **Soft assertions** (report issues without failing test for minor issues)
- ✅ **Data flow verification** (edit → reload → persist)
- ✅ **Targets known bugs** (maps directly to Gap 1–8)
- ✅ **Suitable for Bob** (structured output can feed into query_atlas/oracle)
- ✅ **Self-documenting** (code IS the user journey)

---

## How to Run

### Quick start
```bash
cd apps/web
bash run-manual-walkthroughs.sh

# Then either:
npx playwright test e2e/*manual-walkthrough*.spec.ts
npx playwright test e2e/crm-portfolio-manual-walkthrough.spec.ts
npx playwright show-report
```

### Bob VPS Verification
```bash
npm run build
npx playwright test e2e/*manual-walkthrough*.spec.ts
```

### With live Supabase + Vite dev server
```bash
# Terminal 1: Start dev server
npm run dev

# Terminal 2: Run tests
npx playwright test --ui
```

---

## Expected Output

### Success scenario:
```
✓ CRM link found and navigated
✓ Opened first client detail view
✓ Account manager field visible: "Morgan Reed"
✓ Sites section visible
✓ Map/boundary section visible
✓ Rates section visible
✓ Data persisted correctly
```

### Failure scenarios (caught by tests):

**Gap 1 — RLS/FK failure:**
```
⚠⚠⚠ ALERT: Account manager field empty — possible RLS/FK failure
⚠⚠⚠ ALERT: Permission denied error visible — RLS policy may be broken
```

**Gap 2 — Missing SLA writer:**
```
⚠⚠⚠ CRITICAL: sla_respond_by is NULL — trigger not writing field! (Gap 2)
⚠⚠⚠ CRITICAL: sla_minutes is NULL — SLA window not configured
```

**Gap 3 — Missing resolver writer:**
```
⚠⚠⚠ CRITICAL: Resolver field not populated — data writer missing! (Gap 3)
  The resolve RPC likely does not write resolved_by or resolved_at
```

---

## Next Steps

### Immediate (before next build):
1. **Run these tests** against live dev server
   ```bash
   npm run dev &
   npx playwright test e2e/*manual-walkthrough*.spec.ts
   ```
2. **Review console output** for any Gap 1–3 failures
3. **If failures found:** Feed to Bob for targeted fix recommendations

### Short-term (this sprint):
1. Create remaining 3 test suites (Roster-HR, Field Ops, Shells)
2. Superseded by the 2026-10-12 owner ruling: Bob's VPS owns verification; GitHub Actions are not used.
3. Set output baseline (log comparison across builds)

### Long-term:
1. Bob's oracle can parse manual walkthrough logs to identify failing surfaces
2. Conductor can prioritize which pages to test based on pending changes
3. Manual walkthrough results feed Atlas blast-radius queries

---

## Files Created/Modified

### New files:
- ✅ `apps/web/e2e/crm-portfolio-manual-walkthrough.spec.ts` (334 lines)
- ✅ `apps/web/e2e/welfare-alerts-manual-walkthrough.spec.ts` (288 lines)
- ✅ `apps/web/e2e/dispatch-jobs-manual-walkthrough.spec.ts` (323 lines)
- ✅ `docs/MANUAL_TESTING_PLAYBOOK.md` (strategic guide)
- ✅ `apps/web/run-manual-walkthroughs.sh` (helper script)

### Modified files:
- None (tests are additive, no existing test changes)

---

## Alignment to Bob's "Human Test" Pattern

This system resurrects Bob's old "Dr. Bot" testing approach from FreedomCamp-Manager:
- **Human walkthrough:** Code mirrors real user actions (click, fill, observe)
- **Visible output:** Console logs show what test "sees" (suitable for Bob to read)
- **Data flow focus:** Verifies end-to-end persistence, not just UI snapshot
- **Modular:** Each test is one complete workflow (can be run standalone)
- **Gap-targeted:** Each test maps to known critical issues to prioritize fixing

---

## Success Metrics

Test suite is successful when:
1. ✅ Tests run without crashes against dev server
2. ✅ Console output clearly shows pass/fail for each phase
3. ✅ Detects real Gap 1, Gap 2, Gap 3 failures in current code
4. ✅ Output can be read/parsed by Bob or automated review
5. ✅ Running tests takes < 5 minutes total (fast feedback)

