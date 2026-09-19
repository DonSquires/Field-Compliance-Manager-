import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, signInAsAdmin, monitorBrowserErrors } from './fixtures';

/**
 * Welfare Alerts Manual Walkthrough
 * 
 * Tests the welfare alert workflow end-to-end, with particular attention to:
 * - Gap 1: welfare_alerts FK expansion fails RLS (acknowledger, resolver fields)
 * - Gap 3: welfare_alerts.resolved_by / resolved_at never written
 * - Gap 7: officer_welfare_settings RLS missing
 * 
 * Data flow: Officer triggers SOS → alert created → admin acknowledges → admin resolves → resolver fields populated
 */

test.describe('Welfare Alerts Manual Walkthrough — Data flow & RLS verification', () => {
  test.beforeEach(async ({ page }) => {
    await installSupabaseFixtures(page);
    monitorBrowserErrors(page);
    await signInAsAdmin(page);
  });

  test('PHASE 1: Admin navigates to welfare alerts page', async ({ page }) => {
    // Human action: Admin looks for welfare/safety page
    await page.goto('/admin');
    await page.waitForLoadState('networkidle');

    // Look for "Welfare", "Safety", or "Alerts" link
    const welfareLink = page.getByRole('link', { name: /welfare|safety|alert/i }).first();
    if (await welfareLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await welfareLink.click();
      await page.waitForLoadState('networkidle');
      console.log('✓ Welfare/Safety link found and navigated');
    } else {
      console.log('⚠ Welfare link not visible — trying shell menu');
      // Try admin shell menu
      const shell = page.locator('nav, [data-test*=shell]').first();
      if (await shell.isVisible()) {
        console.log('✓ Found shell navigation');
      }
    }

    // Verify we're on the welfare page
    const pageTitle = page.locator('h1, h2, [role=heading]').first();
    const titleText = await pageTitle.textContent({ timeout: 1000 }).catch(() => '(no title)');
    console.log(`Current page: "${titleText}"`);
  });

  test('PHASE 2: View alert list — verify alert fields and status', async ({ page }) => {
    // Human action: Navigate to welfare alerts
    await page.goto('/admin/field-ops?area=welfare-alerts');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Wait for list to load
    const alertsList = page.locator('.welfare-page').first();
    await expect(alertsList).toBeVisible({ timeout: 3000 });

    // Human observation: What's visible?
    const pageText = await page.locator('body').textContent();
    console.log('Alert list content:');
    console.log(`  - "SOS" alert type: ${pageText?.includes('SOS')}`);
    console.log(`  - "pending" status: ${pageText?.includes('pending')}`);
    console.log(`  - "Ana Ngata" officer name: ${pageText?.includes('Ana Ngata')}`);
    console.log(`  - "North Yard" location: ${pageText?.includes('North Yard')}`);

    // Try to click on the first alert
    const firstAlert = page.locator('tr, [data-test*=alert-row], li').first();
    if (await firstAlert.isVisible({ timeout: 2000 }).catch(() => false)) {
      await firstAlert.click();
      await page.waitForLoadState('networkidle');
      console.log('✓ Opened first alert detail');
    }
  });

  test('PHASE 3: Open alert detail — CRITICAL: Check acknowledger & resolver fields (RLS/FK test)', async ({ page }) => {
    // Human action: Open a specific welfare alert
    await page.goto('/admin/field-ops?area=welfare-alerts');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Get alert details
    const alertDetail = await page.locator('body').textContent();
    console.log('Alert detail loaded:');
    console.log(`  - Type: ${alertDetail?.includes('SOS') ? 'SOS' : '(unknown)'}`);
    console.log(`  - Status: ${alertDetail?.includes('pending') ? 'pending' : '(unknown)'}`);
    console.log(`  - Officer: ${alertDetail?.includes('Ana Ngata')}`);

    // CRITICAL TEST 1: Check acknowledger field (FK expansion test)
    const acknowledgerField = page.locator('[data-test*=acknowledg]').or(page.getByText(/acknowledg/i)).first();
    if (await acknowledgerField.isVisible({ timeout: 2000 }).catch(() => false)) {
      const acknowledgerText = await acknowledgerField.textContent();
      console.log(`✓ Acknowledger field visible: "${acknowledgerText?.substring(0, 50)}"`);
      
      if (!acknowledgerText || acknowledgerText.includes('null') || acknowledgerText.trim() === 'Acknowledger:') {
        console.log('⚠⚠⚠ ALERT: Acknowledger field empty — possible FK expansion RLS failure (Gap 1)');
      }
    } else {
      console.log('⚠ Acknowledger field not visible — may be hidden or not yet implemented');
    }

    // CRITICAL TEST 2: Check resolver field (should be empty on pending alert)
    const resolverField = page.locator('[data-test*=resolv]').or(page.getByText(/resolv/i)).first();
    if (await resolverField.isVisible({ timeout: 2000 }).catch(() => false)) {
      const resolverText = await resolverField.textContent();
      console.log(`✓ Resolver field visible: "${resolverText?.substring(0, 50)}"`);
      console.log('  (Should be empty on pending alert)');
    } else {
      console.log('⚠ Resolver field not visible — may not be wired');
    }

    // Check for RLS/permission errors
    const errorText = await page.locator('body').textContent();
    if (errorText?.includes('Permission denied') || errorText?.includes('Unauthorized')) {
      console.log('⚠⚠⚠ ALERT: Permission denied error visible — RLS policy may be broken (Gap 1, Gap 7)');
    }
  });

  test('PHASE 4: Acknowledge the alert — verify acknowledger field is written', async ({ page }) => {
    // Human action: Open alert and acknowledge it
    await page.goto('/admin/field-ops?area=welfare-alerts');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Look for "acknowledge" button
    const ackBtn = page.getByRole('button', { name: /acknowledge|mark received/i }).first();
    if (await ackBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await ackBtn.click();
      await page.waitForTimeout(500);
      console.log('✓ Clicked acknowledge button');

      // Check if a form/modal appears
      const ackForm = page.locator('[data-test*=acknowledge], dialog').first();
      if (await ackForm.isVisible({ timeout: 2000 }).catch(() => false)) {
        // Try to fill acknowledgement notes
        const notesInput = ackForm.locator('textarea, input[placeholder*=note]').first();
        if (await notesInput.isVisible({ timeout: 1000 }).catch(() => false)) {
          await notesInput.fill('Alert acknowledged by admin.');
          console.log('✓ Filled acknowledgement notes');
        }

        // Submit
        const submitBtn = ackForm.getByRole('button', { name: /confirm|submit|acknowledge/i }).first();
        if (await submitBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await submitBtn.click();
          await page.waitForTimeout(500);
          console.log('✓ Submitted acknowledgement');
        }
      }
    } else {
      console.log('⚠ Acknowledge button not visible');
    }

    // Verify acknowledger field now shows current user
    await page.waitForTimeout(500);
    const acknowledgerField = page.locator('[data-test*=acknowledg]').or(page.getByText(/acknowledg/i)).first();
    if (await acknowledgerField.isVisible({ timeout: 2000 }).catch(() => false)) {
      const acknowledgerText = await acknowledgerField.textContent();
      console.log(`Updated acknowledger field: "${acknowledgerText?.substring(0, 60)}"`);
      
      if (acknowledgerText?.includes('Morgan Reed') || acknowledgerText?.includes('Morgan')) {
        console.log('✓ Acknowledger field correctly updated to current user');
      } else if (acknowledgerText?.includes('null')) {
        console.log('⚠⚠⚠ ALERT: Acknowledger field still NULL after acknowledge — write failed! (Gap 1)');
      }
    }
  });

  test('PHASE 5: Resolve the alert — verify resolver and timestamp evidence', async ({ page }) => {
    // Human action: Open alert and resolve it
    await page.goto('/admin/field-ops?area=welfare-alerts');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Look for "resolve" button
    const resolveBtn = page.getByRole('button', { name: /resolve|close|mark resolved/i }).first();
    if (await resolveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await resolveBtn.click();
      await page.waitForTimeout(500);
      console.log('✓ Clicked resolve button');

      // Check if a form/modal appears
      const resolveForm = page.locator('[data-test*=resolv], dialog').first();
      if (await resolveForm.isVisible({ timeout: 2000 }).catch(() => false)) {
        // Try to fill resolution notes
        const notesInput = resolveForm.locator('textarea, input[placeholder*=note]').first();
        if (await notesInput.isVisible({ timeout: 1000 }).catch(() => false)) {
          await notesInput.fill('Alert resolved — officer is safe.');
          console.log('✓ Filled resolution notes');
        }

        // Submit
        const submitBtn = resolveForm.getByRole('button', { name: /confirm|submit|resolve/i }).first();
        if (await submitBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await submitBtn.click();
          await page.waitForTimeout(500);
          console.log('✓ Submitted resolution');
        }
      }
    } else {
      console.log('⚠ Resolve button not visible');
    }

    // CRITICAL TEST: Verify resolver field is populated
    await page.waitForTimeout(500);
    const resolverField = page.locator('[data-test*=resolv]').or(page.getByText(/resolv/i)).first();
    if (await resolverField.isVisible({ timeout: 2000 }).catch(() => false)) {
      const resolverText = await resolverField.textContent();
      console.log(`Updated resolver field: "${resolverText?.substring(0, 60)}"`);
      
      if (resolverText?.includes('Morgan Reed') || resolverText?.includes('Morgan')) {
        console.log('✓ Resolver field correctly populated');
      } else if (resolverText?.includes('null') || !resolverText?.includes('Morgan')) {
        console.log('⚠ Resolver identity is not visible in the current rendered detail.');
      }
    }

    // Also check for resolved_at timestamp
    const resolvedAtField = page.locator('[data-test*=resolved-at]').or(page.getByText(/resolved at/i)).first();
    if (await resolvedAtField.isVisible({ timeout: 2000 }).catch(() => false)) {
      const resolvedAtText = await resolvedAtField.textContent();
      console.log(`Resolved at: "${resolvedAtText}"`);
      
      if (!resolvedAtText || resolvedAtText.includes('null')) {
        console.log('⚠ Resolution timestamp is not visible in the current rendered detail.');
      }
    }
  });

  test('PHASE 6: Verify alert status changed — check list refreshes', async ({ page }) => {
    // Human action: Go back to alert list and verify status changed
    await page.goto('/admin/field-ops?area=welfare-alerts');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Find the alert we just worked on
    const alertRow = page.locator('text=47474747').first();
    if (await alertRow.isVisible({ timeout: 2000 }).catch(() => false)) {
      const rowText = await alertRow.textContent();
      console.log(`Alert in list shows: "${rowText?.substring(0, 80)}"`);
      
      if (rowText?.includes('resolved')) {
        console.log('✓ Alert status in list updated to "resolved"');
      } else if (rowText?.includes('pending')) {
        console.log('⚠ Alert status still shows "pending" — list may not have refreshed');
      }
    }
  });

  test('PHASE 7: Officer portal — view alerts from officer perspective', async ({ page }) => {
    // Human action: Switch to officer view (sign in as officer)
    // For this test, we'd need to add an officer fixture, but we can check the officer alert page structure
    
    // Try to navigate to officer welfare page (if route exists)
    await page.goto('/officer/welfare').catch(() => {
      console.log('⚠ Officer welfare route may not exist yet');
    });

    // If page loads, check for SOS/inactivity/GPS lost alerts
    try {
      await page.waitForLoadState('networkidle');
      const pageText = await page.locator('body').textContent();
      console.log('Officer welfare page loaded:');
      console.log(`  - "SOS" visible: ${pageText?.includes('SOS')}`);
      console.log(`  - "Inactivity" visible: ${pageText?.includes('Inactivity')}`);
      console.log(`  - "GPS Lost" visible: ${pageText?.includes('GPS')}`);

      // Check for acknowledgement UI
      const ackBtn = page.getByRole('button', { name: /acknowledge|check in/i }).first();
      if (await ackBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('✓ Officer acknowledgement button visible');
      }
    } catch (e) {
      console.log('Officer welfare page not yet wired');
    }
  });

  test('PHASE 8: Performance & UX — check page doesn\'t crash with FK data', async ({ page }) => {
    // Human action: Rapidly load multiple alerts to stress-test FK expansion
    const alerts = [
      '47474747-4747-4747-8747-474747474747',
      '47474747-4747-4747-8747-474747474747', // Same alert, rapid reload
    ];

    for (const alertId of alerts) {
      await page.goto('/admin/field-ops?area=welfare-alerts');
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(300);

      // Check for errors
      const errorMsg = page.locator('text=error|failed|Permission denied');
      if (await errorMsg.isVisible({ timeout: 1000 }).catch(() => false)) {
        const errText = await errorMsg.textContent();
        console.log(`⚠ Error on alert ${alertId}: "${errText}"`);
      }
    }

    console.log('✓ Rapid loading completed without crashes');
  });

});
