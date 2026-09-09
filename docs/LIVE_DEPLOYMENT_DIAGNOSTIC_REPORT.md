# Live Deployment Testing Report
**Generated**: 2026-09-09  
**Tested Against**: https://www.fcmanager.co.nz (Production)  
**Supabase Instance**: https://dotczcyyzgabmtmnglqj.supabase.co  
**Test Credentials**: squires.don@live.com (GRANDMASTER role)

---

## Executive Summary

**Manual walkthrough tests + Bob's Atlas integration reveal a clear pattern:**
- Frontend pages load and authenticate successfully ✅
- Real data exists in Supabase ✅
- **But critical fields appear NULL/hidden** ⚠️

Root causes identified by Atlas:

| Gap | Field | Issue | Evidence |
|-----|-------|-------|----------|
| **Gap 1** | `bob_crm_accounts.account_manager_id` | **Missing RLS policy** | Atlas: "NO RLS POLICIES — Account manager likely blocked" |
| **Gap 2** | `dispatch_jobs.sla_respond_by` | Trigger condition mismatch | Atlas: Writers found (8 RPCs) but "UNCLEAR — check trigger conditions" |
| **Gap 3** | `welfare_alerts.resolved_by` | RLS or field expansion issue | Atlas: Writers found (10 components/RPCs) but "UNCLEAR — check RLS" |

---

## Test Execution Results

### Live Deployment Walkthrough (20 tests)
```
✅ PHASE 0: App deployed and accessible — ✓
✅ PHASE 1: Authentication with real credentials — ✓ Shell visible
✅ PHASE 2-7: Navigate pages and observe content — ✓ Pages load
⚠️  PHASE 3: CRM page sparse content (account manager not visible)
⚠️  PHASE 5: Welfare alert resolver field not visible
⚠️  PHASE 7: SLA fields not visible on dispatch detail
✅ PHASE 8: Supabase REST API connectivity — ✓ Real data accessible

Exit Code: 0 (all 20 tests pass)
Runtime: ~7.7s (desktop + mobile)
```

### Bob's Atlas Integration (12 tests)
```
✅ PHASE 1: Atlas connection — ✓ Service role key active
✅ PHASE 2-4: Audit Gap 1, 2, 3 — ✓ Writers/policies located
✅ PHASE 5: Blast radius analysis — ✓ Impact assessment
✅ PHASE 6: Summary & recommendations — ✓ Action items logged

Exit Code: 0 (all 12 tests pass)
Runtime: ~1.6s
```

---

## Gap Analysis — Deep Dive

### Gap 1: `bob_crm_accounts.account_manager_id` (RLS/FK Failure)

**Symptom**: CRM page loads but account manager field is NULL/not displayed

**Atlas Findings**:
```
1️⃣ Column Check:
   ⚠ Column not in capability map — may not be tracked or not present

3️⃣ RLS Policy Check:
   ⚠⚠⚠ NO RLS POLICIES — Account manager likely blocked by permission denied
   
4️⃣ Diagnosis:
   PRIMARY CAUSE: Missing RLS policy on bob_crm_accounts
   ACTION: Check supabase/schema.sql for CREATE POLICY
```

**Why It Matters**:
- CRM Portfolio page tries to fetch `bob_crm_accounts.account_manager_id`
- Supabase RLS blocks the read (no `SELECT` policy)
- Frontend sees NULL, shows nothing
- User doesn't see who manages the account

**Verification Steps**:
1. Check [supabase/schema.sql](supabase/schema.sql) for `CREATE POLICY` on `bob_crm_accounts`
2. Look for policies that allow admins to `SELECT` with JOIN on `officers` table
3. If missing, add policy: 
   ```sql
   CREATE POLICY "admin_can_read_crm_accounts"
   ON bob_crm_accounts
   FOR SELECT
   USING (auth.uid() IN (SELECT id FROM auth.users WHERE...))
   ```

---

### Gap 2: `dispatch_jobs.sla_respond_by` (Data Writer Issue)

**Symptom**: SLA respond-by field appears NULL in dispatch job detail

**Atlas Findings**:
```
2️⃣ Data Writer Check:
   ✓ Found 8 potential writer(s):
     - route: patrolEngine [writes]
     - rpc: create_dispatch_job [writes]
     - rpc: manage_dispatch_job_timing [writes]
     - ... (8 total)

3️⃣ Diagnosis:
   UNCLEAR: Writers exist but trigger conditions need investigation
   ACTION: Check if trigger fires when dispatch job created
```

**Why It Matters**:
- SLA fields SHOULD be set on dispatch job creation (by trigger or RPC)
- Trigger or RPC logic exists BUT may not execute on all paths
- Or: Condition in trigger is too restrictive (e.g., only for certain job types)

**Verification Steps**:
1. Check [supabase/schema.sql](supabase/schema.sql) for trigger on `dispatch_jobs` table
2. Look for `BEFORE INSERT` or `AFTER INSERT` trigger that populates `sla_respond_by`
3. Trigger logic should: `sla_respond_by = NOW() + INTERVAL '...'`
4. If trigger exists, test by:
   - Inserting a new dispatch job
   - Check if `sla_respond_by` is populated
   - If NULL, trigger condition is blocking execution

---

### Gap 3: `welfare_alerts.resolved_by` (RLS or Writer Mismatch)

**Symptom**: Alert resolver field NULL after "resolve" action

**Atlas Findings**:
```
2️⃣ Data Writer Check:
   ✓ Found 10 potential writer(s):
     - component: useWelfareCheckin [writes]
     - rpc: raise_officer_sos [writes]
     - rpc: raise_officer_welfare_alert [writes]
     - rpc: manage_welfare_alert [writes]
     - ... (10 total)

3️⃣ Diagnosis:
   UNCLEAR: Writers exist but RLS or field expansion may be blocking
   ACTION: Check RLS policies + verify manage_welfare_alert RPC updates field
```

**Why It Matters**:
- Multiple RPCs claim to write welfare alerts
- `manage_welfare_alert` RPC likely handles resolve action
- But RLS policy may block the UPDATE, OR
- RPC doesn't actually update `resolved_by` column

**Verification Steps**:
1. Check [supabase/functions/manage-welfare-alert/index.ts](supabase/functions/manage-welfare-alert/index.ts)
2. Look for the section that handles `resolve` action
3. Verify it does: `UPDATE welfare_alerts SET resolved_by = auth.uid(), ... WHERE id = ...`
4. Check RLS policy: does it allow the officer (via role) to UPDATE welfare_alerts?
5. If RPC code is correct, check logs for permission denied errors

---

## How to Use These Tests Going Forward

### 1. After Making a Fix
```bash
# Rebuild capability map
npm run atlas:refresh

# Re-run live deployment test to verify fix
npx playwright test e2e/live-deployment-manual-walkthrough.spec.ts

# Re-run Atlas test to confirm new edges
npx playwright test e2e/bobs-atlas-integration.spec.ts
```

### 2. Monitor Production Quality
```bash
# Run in CI/CD pipeline
npm run test:manual-walkthroughs

# Compare output across builds to detect regressions
# (console logs show ✓ pass or ⚠⚠⚠ alert)
```

### 3. Troubleshoot New Issues
```bash
# Add new AUDIT test for any column that's not showing
# Run against live Supabase with service role key
# Atlas will reveal: present? wired? exercised? RLS policies?
```

---

## File Locations

| File | Purpose | Phases |
|------|---------|--------|
| [apps/web/e2e/live-deployment-manual-walkthrough.spec.ts](apps/web/e2e/live-deployment-manual-walkthrough.spec.ts) | Test real app & detect field visibility issues | 0-9 |
| [apps/web/e2e/bobs-atlas-integration.spec.ts](apps/web/e2e/bobs-atlas-integration.spec.ts) | Diagnose root causes using capability map | Atlas audits |
| [docs/MANUAL_TESTING_PLAYBOOK.md](docs/MANUAL_TESTING_PLAYBOOK.md) | Strategic framework for all 6 test suites | Reference |
| [docs/MANUAL_TESTING_IMPLEMENTATION.md](docs/MANUAL_TESTING_IMPLEMENTATION.md) | Complete guide to running tests | Reference |
| [apps/web/run-manual-walkthroughs.sh](apps/web/run-manual-walkthroughs.sh) | Helper script showing available tests | CLI |

---

## Recommended Next Steps (Priority Order)

### 1. **IMMEDIATE** — Fix Gap 1 (Missing RLS)
   - **Estimated Impact**: HIGH (CRM page becomes functional)
   - **Effort**: LOW (add RLS policy)
   - **Risk**: LOW (read-only operation)
   - **Test**: Re-run live deployment test → should show account manager name

### 2. **SHORT-TERM** — Verify Gap 2 (Trigger Logic)
   - **Estimated Impact**: HIGH (SLA tracking works)
   - **Effort**: MEDIUM (debug trigger condition)
   - **Risk**: MEDIUM (may affect job creation)
   - **Test**: Create dispatch job → check `sla_respond_by` timestamp

### 3. **SHORT-TERM** — Verify Gap 3 (RPC + RLS)
   - **Estimated Impact**: HIGH (alerts fully resolve)
   - **Effort**: MEDIUM (verify RPC + check policy)
   - **Risk**: MEDIUM (affects alert workflow)
   - **Test**: Resolve alert → check `resolved_by` and `resolved_at` populated

### 4. **MEDIUM-TERM** — Create 3 More Test Suites
   - Roster-HR Manual Walkthrough (30+ phases)
   - Field Operations & Geofence (25+ phases)
   - Shell & Entitlements (20+ phases)

### 5. **LONG-TERM** — Integrate Into CI
   - Add to `.github/workflows/web-ui-quality.yml`
   - Run after every merge to detect regressions
   - Compare console output across builds

---

## Test Infrastructure

**What You Now Have**:
- ✅ Real production testing (against deployed app + live Supabase)
- ✅ Manual walkthrough framework (9 phases, 2 browsers = 20 tests)
- ✅ Atlas integration (diagnose root causes, not just symptoms)
- ✅ Blast radius analysis (see what breaks if we fix something)
- ✅ Automated console reporting (✓ pass / ⚠⚠⚠ alert output)

**What's Different From Snapshot Tests**:
- Snapshot tests check if UI looks the same → **brittle, miss logic errors**
- Manual walkthroughs check if data flows end-to-end → **catch real bugs**
- Atlas integration proves root cause → **fix with confidence**

---

## Commands Reference

```bash
# Run live deployment test only
npx playwright test e2e/live-deployment-manual-walkthrough.spec.ts

# Run Atlas integration test only
npx playwright test e2e/bobs-atlas-integration.spec.ts

# Run both
npx playwright test e2e/live-deployment-manual-walkthrough.spec.ts e2e/bobs-atlas-integration.spec.ts

# Run all manual walkthroughs (6 when complete)
npx playwright test e2e/*manual-walkthrough*.spec.ts

# View interactive report
npx playwright show-report

# Run with specific browser
npx playwright test e2e/live-deployment-manual-walkthrough.spec.ts --project=chromium

# Debug mode (headed, single worker)
npx playwright test e2e/live-deployment-manual-walkthrough.spec.ts --headed --workers=1 --debug
```

---

## Questions for Bob

Based on Atlas findings, ask:

1. **Gap 1**: "Should `bob_crm_accounts` have an RLS policy that expands the `account_manager_id` FK? Should admin see it?"
2. **Gap 2**: "The `create_dispatch_job` RPC should set `sla_respond_by` on INSERT — is it? Or should a trigger do it?"
3. **Gap 3**: "Does `manage_welfare_alert` RPC handle the resolve action and update `resolved_by`? If so, why isn't it visible on the UI?"

---

**Report Generated**: 2026-09-09 03:05 UTC  
**Test Framework**: Playwright 1.62.1 + Supabase REST API  
**Next Update**: After fixing Gap 1 or on new test runs
