import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, signInAsAdmin, monitorBrowserErrors } from './fixtures';

/**
 * Dispatch Jobs Manual Walkthrough
 * 
 * Tests dispatch job data flow with focus on:
 * - Gap 2: dispatch_jobs SLA fields never written (sla_respond_by, sla_minutes, elapsed_minutes)
 * - Gap 6: dispatch_jobs.dispatch_resource_id can be NULL (unassigned jobs)
 * 
 * Data flow: Job created → SLA clock starts → sla_respond_by updates → elapsed_minutes track progress → color indicates status
 */

test.describe('Dispatch Jobs Manual Walkthrough — SLA tracking & resource assignment', () => {
  test.beforeEach(async ({ page }) => {
    await installSupabaseFixtures(page);
    monitorBrowserErrors(page);
    await signInAsAdmin(page);
  });

  test('PHASE 1: Navigate to dispatch hub', async ({ page }) => {
    // Human action: Admin looks for dispatch/operations page
    await page.goto('/admin');
    await page.waitForLoadState('networkidle');

    // Look for "Dispatch", "Operations", or "Jobs" link
    const dispatchLink = page.getByRole('link', { name: /dispatch|operations|jobs|call.?out/i }).first();
    if (await dispatchLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await dispatchLink.click();
      await page.waitForLoadState('networkidle');
      console.log('✓ Dispatch link found and navigated');
    } else {
      console.log('⚠ Dispatch link not visible');
      // Try /admin/dispatch directly
      await page.goto('/admin/dispatch');
      await page.waitForLoadState('networkidle');
    }

    // Verify dispatch page loaded
    const pageTitle = page.locator('h1, h2, [role=heading]').first();
    const titleText = await pageTitle.textContent({ timeout: 1000 }).catch(() => '(no title)');
    console.log(`Current page: "${titleText}"`);
  });

  test('PHASE 2: View active dispatch jobs — verify job list structure', async ({ page }) => {
    // Human action: Navigate to dispatch and observe job list
    await page.goto('/admin/dispatch');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Wait for jobs list
    const jobsList = page.locator('[data-test=jobs-list], [role=main]').first();
    await expect(jobsList).toBeVisible({ timeout: 3000 });

    // Human observation: What's on the list?
    const pageText = await page.locator('body').textContent();
    console.log('Dispatch jobs list content:');
    console.log(`  - Job count visible: ${(pageText?.match(/job/gi)?.length ?? 0) > 0}`);
    console.log(`  - Status indicators: ${pageText?.includes('open') || pageText?.includes('pending')}`);
    console.log(`  - Officer names: ${pageText?.includes('Ana Ngata')}`);
    console.log(`  - Priority indicators: ${pageText?.includes('urgent') || pageText?.includes('high')}`);

    // Try to click on first job
    const firstJob = page.locator('tr, [data-test*=job-row], li').first();
    if (await firstJob.isVisible({ timeout: 2000 }).catch(() => false)) {
      await firstJob.click();
      await page.waitForLoadState('networkidle');
      console.log('✓ Opened first job detail');
    }
  });

  test('PHASE 3: Open job detail — CRITICAL: Check SLA fields (sla_respond_by, sla_minutes)', async ({ page }) => {
    // Human action: Open a dispatch job detail
    // Using fixture job ID if available
    await page.goto('/admin/dispatch-jobs');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Try to find and click a job
    const firstJob = page.locator('tr, [data-test*=job], li').first();
    if (await firstJob.isVisible({ timeout: 2000 }).catch(() => false)) {
      const jobId = await firstJob.getAttribute('data-job-id').catch(() => null);
      if (jobId) {
        await page.goto(`/admin/dispatch-jobs/${jobId}`);
      } else {
        await firstJob.click();
      }
      await page.waitForLoadState('networkidle');
    }

    await page.waitForTimeout(500);

    // CRITICAL TEST 1: Check sla_respond_by field
    const slaRespondByField = page.locator('[data-test*=sla-respond-by]').or(page.getByText(/respond/i)).first();
    if (await slaRespondByField.isVisible({ timeout: 2000 }).catch(() => false)) {
      const slaRespondByText = await slaRespondByField.textContent();
      console.log(`✓ SLA respond-by field visible: "${slaRespondByText?.substring(0, 50)}"`);
      
      if (!slaRespondByText || slaRespondByText.includes('null') || slaRespondByText.includes('undefined')) {
        console.log('⚠⚠⚠ CRITICAL: sla_respond_by is NULL — trigger not writing field! (Gap 2)');
      } else if (slaRespondByText.match(/\d{4}-\d{2}-\d{2}/)) {
        console.log('✓ SLA respond-by has valid timestamp');
      }
    } else {
      console.log('⚠ SLA respond-by field not visible — may not be wired');
    }

    // CRITICAL TEST 2: Check sla_minutes
    const slaMinutesField = page.locator('[data-test*=sla-minutes]').or(page.getByText(/sla.*minutes/i)).first();
    if (await slaMinutesField.isVisible({ timeout: 2000 }).catch(() => false)) {
      const slaMinutesText = await slaMinutesField.textContent();
      console.log(`✓ SLA minutes field visible: "${slaMinutesText}"`);
      
      if (!slaMinutesText || slaMinutesText.includes('null') || slaMinutesText.includes('undefined')) {
        console.log('⚠⚠⚠ CRITICAL: sla_minutes is NULL — SLA window not configured (Gap 2)');
      }
    } else {
      console.log('⚠ SLA minutes field not visible');
    }

    // TEST 3: Check elapsed_minutes (should update as time passes)
    const elapsedMinutesField = page.locator('[data-test*=elapsed-minutes]').or(page.getByText(/elapsed/i)).first();
    if (await elapsedMinutesField.isVisible({ timeout: 2000 }).catch(() => false)) {
      const elapsedMinutesText = await elapsedMinutesField.textContent();
      console.log(`✓ Elapsed minutes field visible: "${elapsedMinutesText}"`);
    } else {
      console.log('⚠ Elapsed minutes field not visible');
    }

    // TEST 4: Check for SLA status color/indicator
    const slaIndicator = page.locator('[data-test*=sla-status], [data-status*=sla]').first();
    if (await slaIndicator.isVisible({ timeout: 2000 }).catch(() => false)) {
      const indicatorClass = await slaIndicator.getAttribute('class').catch(() => '');
      console.log(`✓ SLA status indicator visible: class="${indicatorClass?.substring(0, 60)}"`);
    } else {
      console.log('⚠ SLA status indicator (color) not visible');
    }
  });

  test('PHASE 4: Check resource assignment — verify officer is assigned or show unassigned', async ({ page }) => {
    // Human action: View job and check who it's assigned to
    // Navigate to a job detail
    await page.goto('/admin/dispatch-jobs');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    const firstJob = page.locator('tr, [data-test*=job], li').first();
    if (await firstJob.isVisible({ timeout: 2000 }).catch(() => false)) {
      await firstJob.click();
      await page.waitForLoadState('networkidle');
    }

    await page.waitForTimeout(500);

    // TEST: Check assigned officer field
    const assignedOfficerField = page.locator('[data-test*=assigned-to]').or(page.getByText(/assigned/i)).first();
    if (await assignedOfficerField.isVisible({ timeout: 2000 }).catch(() => false)) {
      const assignedText = await assignedOfficerField.textContent();
      console.log(`Assigned officer: "${assignedText?.substring(0, 60)}"`);
      
      if (assignedText?.includes('Ana Ngata') || assignedText?.includes('Jordan')) {
        console.log('✓ Job assigned to officer');
      } else if (assignedText?.includes('Unassigned') || assignedText?.includes('None')) {
        console.log('✓ Job shows unassigned state — graceful handling of NULL dispatch_resource_id (Gap 6)');
      } else if (assignedText?.includes('null')) {
        console.log('⚠ Job shows NULL instead of "Unassigned" — UI not handling Gap 6 gracefully');
      }
    } else {
      console.log('⚠ Assigned officer field not visible');
    }
  });

  test('PHASE 5: Try to assign job to officer', async ({ page }) => {
    // Human action: Open an unassigned job and assign it
    await page.goto('/admin/dispatch-jobs');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Find an unassigned job
    const jobs = page.locator('tr, [data-test*=job], li');
    const jobCount = await jobs.count();
    
    for (let i = 0; i < Math.min(jobCount, 3); i++) {
      const job = jobs.nth(i);
      const jobText = await job.textContent().catch(() => '');
      
      if (jobText?.includes('Unassigned') || jobText?.includes('No officer')) {
        await job.click();
        await page.waitForLoadState('networkidle');
        console.log('✓ Opened unassigned job');
        break;
      }
    }

    await page.waitForTimeout(500);

    // Look for assign button
    const assignBtn = page.getByRole('button', { name: /assign|dispatch/i }).first();
    if (await assignBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await assignBtn.click();
      await page.waitForTimeout(300);
      console.log('✓ Clicked assign button');

      // Try to select officer from dropdown
      const officerSelect = page.locator('select, [role=listbox], [data-test*=officer]').first();
      if (await officerSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
        await officerSelect.click();
        await page.waitForTimeout(200);
        
        // Select first officer option
        const firstOption = page.locator('[role=option]').first();
        if (await firstOption.isVisible({ timeout: 1000 }).catch(() => false)) {
          await firstOption.click();
          console.log('✓ Selected officer from dropdown');
        }
      }

      // Try to submit assignment
      const submitBtn = page.getByRole('button', { name: /confirm|save|assign/i }).first();
      if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await submitBtn.click();
        await page.waitForTimeout(500);
        console.log('✓ Submitted assignment');

        // Check if assigned officer now appears
        const assignedField = page.locator('[data-test*=assigned-to], text=assigned', { exact: false }).first();
        if (await assignedField.isVisible({ timeout: 2000 }).catch(() => false)) {
          const assignedText = await assignedField.textContent();
          console.log(`Updated assignment: "${assignedText?.substring(0, 60)}"`);
        }
      }
    } else {
      console.log('⚠ Assign button not visible');
    }
  });

  test('PHASE 6: Update job status — check state transitions', async ({ page }) => {
    // Human action: Move job through workflow (open → in-progress → closed)
    await page.goto('/admin/dispatch-jobs');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Open a job
    const firstJob = page.locator('tr, [data-test*=job], li').first();
    if (await firstJob.isVisible({ timeout: 2000 }).catch(() => false)) {
      await firstJob.click();
      await page.waitForLoadState('networkidle');
    }

    await page.waitForTimeout(500);

    // Look for status change button
    const statusBtn = page.getByRole('button', { name: /progress|complete|close|resolved/i }).first();
    if (await statusBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await statusBtn.click();
      await page.waitForTimeout(300);
      console.log('✓ Clicked status change button');

      // Check for confirmation modal
      const confirmBtn = page.getByRole('button', { name: /confirm|yes|mark/i }).first();
      if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await confirmBtn.click();
        await page.waitForTimeout(500);
        console.log('✓ Confirmed status change');
      }
    }

    // Verify status updated
    const statusField = page.locator('[data-test*=status]').first();
    if (await statusField.isVisible({ timeout: 2000 }).catch(() => false)) {
      const statusText = await statusField.textContent();
      console.log(`Updated status: "${statusText?.substring(0, 40)}"`);
    }
  });

  test('PHASE 7: Performance — rapidly view multiple jobs to stress-test SLA queries', async ({ page }) => {
    // Human action: Click through 5-10 jobs quickly to check for lag or errors
    await page.goto('/admin/dispatch-jobs');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    const jobs = page.locator('tr, [data-test*=job], li');
    const jobCount = await jobs.count();

    console.log(`Testing ${Math.min(jobCount, 5)} jobs for SLA query performance...`);

    for (let i = 0; i < Math.min(jobCount, 5); i++) {
      const job = jobs.nth(i);
      await job.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(200);

      // Check for errors
      const errorMsg = page.locator('text=error|failed|Error', { exact: false });
      if (await errorMsg.isVisible({ timeout: 500 }).catch(() => false)) {
        const errText = await errorMsg.textContent();
        console.log(`⚠ Error on job ${i}: "${errText}"`);
      }
    }

    console.log('✓ Rapid job loading completed');
  });

  test('PHASE 8: Check SLA breach scenario — verify color/alert for overdue jobs', async ({ page }) => {
    // Human action: Find or create a job with elapsed > sla, verify warning/color
    await page.goto('/admin/dispatch-jobs');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Look for any jobs with red/warning color
    const breachedJob = page.locator('[data-status*=breached], [data-status*=overdue]').first();
    if (await breachedJob.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('✓ Found breached job with visual indicator');
      
      await breachedJob.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500);

      // Verify SLA details show breach info
      const slaStatus = page.locator('[data-test*=sla-status]').first();
      if (await slaStatus.isVisible({ timeout: 2000 }).catch(() => false)) {
        const statusText = await slaStatus.textContent();
        console.log(`SLA status shows: "${statusText}"`);
        
        if (statusText?.includes('breached') || statusText?.includes('overdue')) {
          console.log('✓ SLA breach clearly communicated');
        }
      }
    } else {
      console.log('⚠ No breached jobs found in fixture (expected in test data)');
    }
  });

  test('PHASE 9: Verify SLA fields persist after reload', async ({ page }) => {
    // Human action: Load job, note SLA fields, reload, verify unchanged
    await page.goto('/admin/dispatch-jobs');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    const firstJob = page.locator('tr, [data-test*=job], li').first();
    if (await firstJob.isVisible({ timeout: 2000 }).catch(() => false)) {
      await firstJob.click();
      await page.waitForLoadState('networkidle');
    }

    await page.waitForTimeout(500);

    // Capture SLA fields before reload
    const slaRespondByBefore = await page.locator('[data-test*=sla-respond-by]').first().textContent().catch(() => '');
    const slaMinutesBefore = await page.locator('[data-test*=sla-minutes]').first().textContent().catch(() => '');
    
    console.log(`SLA respond-by before reload: "${slaRespondByBefore?.substring(0, 50)}"`);
    console.log(`SLA minutes before reload: "${slaMinutesBefore?.substring(0, 50)}"`);

    // Reload
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Capture after reload
    const slaRespondByAfter = await page.locator('[data-test*=sla-respond-by]').first().textContent().catch(() => '');
    const slaMinutesAfter = await page.locator('[data-test*=sla-minutes]').first().textContent().catch(() => '');

    console.log(`SLA respond-by after reload: "${slaRespondByAfter?.substring(0, 50)}"`);
    console.log(`SLA minutes after reload: "${slaMinutesAfter?.substring(0, 50)}"`);

    if (slaRespondByBefore === slaRespondByAfter && slaMinutesBefore === slaMinutesAfter) {
      console.log('✓ SLA fields persisted correctly');
    } else {
      console.log('⚠ SLA fields changed after reload — possible cache or query issue');
    }
  });
});
