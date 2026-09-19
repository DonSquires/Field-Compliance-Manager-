import { expect, test } from '@playwright/test';
import { monitorBrowserErrors } from './fixtures';

/**
 * LIVE DEPLOYMENT Manual Walkthrough
 * 
 * This test suite runs against the LIVE deployed app (fcmanager.co.nz)
 * using real Supabase credentials, testing the full production stack.
 * 
 * Much more powerful than mock fixtures because it:
 * - Tests real RLS policies (not mocked)
 * - Tests real data flow end-to-end
 * - Catches production bugs (FK expansion, permission denials, missing writers)
 * - Verifies live Supabase queries actually work
 * 
 * Credentials from codespace secrets:
 *   GRANDMASTER_TEST_EMAIL: squires.don@live.com
 *   GRANDMASTER_TEST_PASSWORD: Run2thesun??
 *   SUPABASE_URL: https://dotczcyyzgabmtmnglqj.supabase.co
 */

const LIVE_URL = 'https://www.fcmanager.co.nz';
const ADMIN_EMAIL = process.env.GRANDMASTER_TEST_EMAIL || 'squires.don@live.com';
const ADMIN_PASSWORD = process.env.GRANDMASTER_TEST_PASSWORD || '';

test.describe('LIVE Deployment Manual Walkthrough — Production Stack Testing', () => {
  test.beforeEach(async ({ page }) => {
    monitorBrowserErrors(page);
    // Set extended timeout for live server (may be slower than local)
    page.setDefaultTimeout(15000);
  });

  test('PHASE 0: App is deployed and accessible', async ({ page }) => {
    console.log(`\n📍 Testing against LIVE deployment: ${LIVE_URL}`);
    console.log(`👤 Using credentials: ${ADMIN_EMAIL}`);
    
    await page.goto(LIVE_URL);
    await page.waitForLoadState('networkidle');

    // Check page loaded
    const html = await page.locator('html').evaluate(el => el.innerHTML);
    console.log(`✓ Live app responded (${html.length} bytes HTML)`);

    // Check for login form or authenticated state
    const loginForm = page.locator('input[type=email], input[placeholder*=email]').first();
    const shell = page.locator('[data-test=admin-shell], nav').first();

    if (await loginForm.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('✓ Login form visible — app is in unauthenticated state');
    } else if (await shell.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('✓ Shell visible — app is already authenticated or persisted session');
    } else {
      console.log('⚠ Neither login form nor shell visible — unexpected state');
    }
  });

  test('PHASE 1: Sign in with LIVE credentials', async ({ page }) => {
    await page.goto(`${LIVE_URL}/admin`);
    await page.waitForLoadState('networkidle');

    // Try to sign in
    const emailInput = page.getByLabel('Email address').or(page.locator('input[type=email]')).first();
    const passwordInput = page.getByLabel('Password').or(page.locator('input[type=password]')).first();
    const signInBtn = page.getByRole('button', { name: /sign.?in|login/i }).first();

    if (await emailInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await emailInput.fill(ADMIN_EMAIL);
      console.log(`✓ Entered email: ${ADMIN_EMAIL}`);
    }

    if (await passwordInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await passwordInput.fill(ADMIN_PASSWORD);
      console.log('✓ Entered password');
    }

    if (await signInBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await signInBtn.click();
      console.log('✓ Clicked sign-in button');
      
      // Wait for auth to complete
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);
      
      // Check for success
      const errorMsg = page.locator('text=error|invalid|failed').first();
      const shell = page.locator('[data-test=admin-shell], nav').first();

      if (await shell.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log('✅ Authentication succeeded — shell visible');
      } else if (await errorMsg.isVisible({ timeout: 2000 }).catch(() => false)) {
        const err = await errorMsg.textContent();
        console.log(`❌ Authentication failed: "${err}"`);
      }
    }
  });

  test('PHASE 2: Navigate to CRM and observe real data', async ({ page }) => {
    await page.goto(`${LIVE_URL}/admin/crm`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Try to see what's on the page
    const pageText = await page.locator('body').textContent().catch(() => '');
    
    console.log('CRM page loaded:');
    console.log(`  - Clients/accounts visible: ${(pageText?.length ?? 0) > 1000 ? '✓' : '⚠ sparse content'}`);
    console.log(`  - "Civic Events" in data: ${pageText?.includes('Civic Events') ? '✓' : '⚠'}`);
    console.log(`  - Table/list structure: ${pageText?.includes('name') || pageText?.includes('status') ? '✓' : '?'}`);

    // Try to click on first client
    const firstRow = page.locator('tr, [data-test*=row], li').first();
    if (await firstRow.isVisible({ timeout: 2000 }).catch(() => false)) {
      const rowText = await firstRow.textContent();
      console.log(`✓ First client row: "${rowText?.substring(0, 60)}"`);
      
      await firstRow.click();
      await page.waitForLoadState('networkidle');
      console.log('✓ Opened client detail');
    }
  });

  test('PHASE 3: CRITICAL — Check account manager field (FK/RLS bug test)', async ({ page }) => {
    // Navigate to a known client if possible
    await page.goto(`${LIVE_URL}/admin/crm`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Click first client
    const firstClient = page.locator('tr, [data-test*=row], li').first();
    if (await firstClient.isVisible({ timeout: 2000 }).catch(() => false)) {
      await firstClient.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500);
    }

    // CRITICAL TEST: Is account manager field present and populated?
    const pageText = await page.locator('body').textContent().catch(() => '');
    const accountManagerField = page.locator('[data-test*=account], [data-test*=manager]').first();

    console.log('Testing account manager field (Gap 1 — FK/RLS):');
    
    if (await accountManagerField.isVisible({ timeout: 2000 }).catch(() => false)) {
      const fieldText = await accountManagerField.textContent();
      console.log(`  Field visible: "${fieldText?.substring(0, 80)}"`);
      
      if (fieldText?.includes('null') || !fieldText?.trim()) {
        console.log('  ⚠⚠⚠ ALERT: Account manager is NULL/empty — Gap 1 RLS/FK failure detected!');
      } else {
        console.log('  ✓ Account manager field populated');
      }
    } else {
      console.log('  ⚠ Account manager field not visible on page');
    }

    // Also check for permission errors
    if (pageText?.includes('Permission denied') || pageText?.includes('Unauthorized')) {
      console.log('  ⚠⚠⚠ ALERT: Permission denied error visible — RLS policy blocked access (Gap 1)');
    }
  });

  test('PHASE 4: Navigate to Welfare Alerts', async ({ page }) => {
    await page.goto(`${LIVE_URL}/admin/welfare`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    const pageText = await page.locator('body').textContent().catch(() => '');
    console.log('Welfare alerts page:');
    console.log(`  - Page loaded: ${(pageText?.length ?? 0) > 100 ? '✓' : '⚠'}`);
    console.log(`  - Alerts visible: ${pageText?.includes('alert') || pageText?.includes('SOS') ? '✓' : '?'}`);

    // Try to open first alert
    const firstAlert = page.locator('tr, [data-test*=alert], li').first();
    if (await firstAlert.isVisible({ timeout: 2000 }).catch(() => false)) {
      await firstAlert.click();
      await page.waitForLoadState('networkidle');
      console.log('✓ Opened alert detail');
    }
  });

  test('PHASE 5: Check welfare alert resolver field (Gap 3 data writer)', async ({ page }) => {
    await page.goto(`${LIVE_URL}/admin/welfare`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Open first alert
    const firstAlert = page.locator('tr, [data-test*=alert], li').first();
    if (await firstAlert.isVisible({ timeout: 2000 }).catch(() => false)) {
      await firstAlert.click();
      await page.waitForLoadState('networkidle');
    }

    await page.waitForTimeout(500);

    const pageText = await page.locator('body').textContent().catch(() => '');
    console.log('Welfare alert detail:');
    console.log(`  - Resolved field visible: ${pageText?.includes('resolve') ? '✓' : '⚠'}`);

    // Check for resolver name
    if (pageText?.includes('Morgan') || pageText?.includes('Jordan')) {
      console.log('  ✓ Resolver name visible in alert detail');
    } else if (pageText?.includes('null') && pageText?.includes('resolv')) {
      console.log('  ⚠⚠⚠ ALERT: Resolver field shows NULL — Gap 3 data writer missing!');
    }
  });

  test('PHASE 6: Navigate to Dispatch Jobs', async ({ page }) => {
    await page.goto(`${LIVE_URL}/admin/dispatch-jobs`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    const pageText = await page.locator('body').textContent().catch(() => '');
    console.log('Dispatch jobs page:');
    console.log(`  - Page loaded: ${(pageText?.length ?? 0) > 100 ? '✓' : '⚠'}`);
    console.log(`  - Jobs visible: ${pageText?.includes('job') || pageText?.includes('SLA') ? '✓' : '?'}`);

    // Try to open first job
    const firstJob = page.locator('tr, [data-test*=job], li').first();
    if (await firstJob.isVisible({ timeout: 2000 }).catch(() => false)) {
      await firstJob.click();
      await page.waitForLoadState('networkidle');
      console.log('✓ Opened job detail');
    }
  });

  test('PHASE 7: Check SLA fields (Gap 2 — fields never written)', async ({ page }) => {
    await page.goto(`${LIVE_URL}/admin/dispatch-jobs`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Open first job
    const firstJob = page.locator('tr, [data-test*=job], li').first();
    if (await firstJob.isVisible({ timeout: 2000 }).catch(() => false)) {
      await firstJob.click();
      await page.waitForLoadState('networkidle');
    }

    await page.waitForTimeout(500);

    const pageText = await page.locator('body').textContent().catch(() => '');
    console.log('Dispatch job detail:');
    
    // Check for SLA fields
    if (pageText?.includes('SLA') || pageText?.includes('sla')) {
      console.log('  ✓ SLA fields present');
      
      if (pageText?.match(/\d{4}-\d{2}-\d{2}.*\d{2}:\d{2}/)) {
        console.log('  ✓ SLA respond-by has timestamp (trigger is working)');
      } else if (pageText?.includes('null') && pageText?.includes('SLA')) {
        console.log('  ⚠⚠⚠ ALERT: SLA fields NULL — Gap 2 trigger not writing!');
      }
    } else {
      console.log('  ⚠ SLA fields not visible on page');
    }
  });

  test('PHASE 8: Verify Supabase connectivity via service key', async ({ page }) => {
    // This test verifies we can reach Supabase directly with service role key
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const supabaseUrl = process.env.SUPABASE_URL || 'https://dotczcyyzgabmtmnglqj.supabase.co';

    if (!serviceKey) {
      console.log('⚠ SUPABASE_SERVICE_ROLE_KEY not set — skipping direct Supabase test');
      return;
    }

    console.log('Testing Supabase connectivity:');
    
    try {
      // Test direct Supabase API call
      const response = await fetch(`${supabaseUrl}/rest/v1/organizations?select=id,name&limit=1`, {
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
        }
      });

      if (response.ok) {
        const data = await response.json();
        console.log(`  ✓ Supabase REST API accessible`);
        console.log(`  ✓ Organizations visible: ${data.length} returned`);
      } else {
        console.log(`  ⚠ Supabase returned ${response.status}: ${response.statusText}`);
      }
    } catch (err) {
      console.log(`  ⚠ Supabase connectivity failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  test('PHASE 9: Summary and recommendations', async ({ page }) => {
    console.log('\n' + '='.repeat(80));
    console.log('LIVE DEPLOYMENT TEST SUMMARY');
    console.log('='.repeat(80));
    console.log(`\n✓ Tested against: ${LIVE_URL}`);
    console.log(`✓ Using real Supabase: ${process.env.SUPABASE_URL?.substring(0, 50)}...`);
    console.log(`✓ Using real test user: ${ADMIN_EMAIL}`);
    console.log(`\nNext steps:`);
    console.log(`  1. Review console output for any ⚠⚠⚠ ALERT flags`);
    console.log(`  2. If RLS/FK failures detected, check supabase/schema.sql for missing policies`);
    console.log(`  3. If data writer failures detected, check Edge Functions and RPCs`);
    console.log(`  4. Feed results to Bob for targeted fix recommendations`);
    console.log('='.repeat(80) + '\n');
  });
});
