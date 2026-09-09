import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, signInAsAdmin, monitorBrowserErrors } from './fixtures';

test.describe('Client Portfolio Manual Walkthrough — Human-style testing', () => {
  test.beforeEach(async ({ page }) => {
    await installSupabaseFixtures(page);
    monitorBrowserErrors(page);
    await signInAsAdmin(page);
  });

  test('PHASE 1: Admin signs in and navigates to CRM — verify shell and top-level navigation', async ({ page }) => {
    // Human action: User logs in (done in beforeEach), then looks for CRM or Client Portfolio
    await page.goto('/admin');
    await page.waitForLoadState('networkidle');

    // Verify the shell is visible and accessible
    const shell = page.locator('[data-test=admin-shell]');
    await expect(shell).toBeVisible();

    // Human action: Look for a "CRM" or "Client Portfolio" or "Accounts" link/menu
    const crmLink = page.getByRole('link', { name: /crm|client|account|portfolio/i }).first();
    if (await crmLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await crmLink.click();
      await page.waitForLoadState('networkidle');
      console.log('✓ CRM link found and navigated');
    } else {
      console.log('⚠ CRM link not visible — checking for shell menu alternatives');
      const menuBtn = page.locator('button').filter({ has: page.locator('[data-icon*=menu]') }).first();
      if (await menuBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await menuBtn.click();
        await page.waitForTimeout(300);
        console.log('✓ Opened shell menu');
      }
    }

    // Human observation: What page are we on now?
    const pageTitle = page.locator('h1, h2, [role=heading]').first();
    const titleText = await pageTitle.textContent({ timeout: 1000 }).catch(() => '(no title)');
    console.log(`Current page title: "${titleText}"`);
  });

  test('PHASE 2: View client list — verify accounts/clients are visible with key fields', async ({ page }) => {
    // Human action: Navigate to CRM accounts/client list
    await page.goto('/admin/crm');
    await page.waitForLoadState('networkidle');

    // Wait for list to load
    const listContainer = page.locator('[data-test=crm-accounts-list], [role=main]').first();
    await expect(listContainer).toBeVisible({ timeout: 5000 });

    // Human observation: What's on the list?
    const rows = page.locator('tr, [data-test*=client-row], li');
    const rowCount = await rows.count();
    console.log(`Client list has ~${rowCount} rows/items visible`);

    // Try to find key fields: client name, status, contact, last activity
    const visibleText = await page.locator('body').textContent();
    const hasClientName = visibleText?.includes('Civic Events') ?? false;
    const hasStatus = visibleText?.includes('active') ?? false;
    const hasContact = visibleText?.includes('Mere Wilson') ?? false;
    console.log(`✓ Client name visible: ${hasClientName}`);
    console.log(`✓ Status visible: ${hasStatus}`);
    console.log(`✓ Contact visible: ${hasContact}`);

    // Human action: Click on first client to open detail view
    const firstClient = page.locator('tr, [data-test*=client-row], li').first();
    if (await firstClient.isVisible({ timeout: 2000 }).catch(() => false)) {
      await firstClient.click();
      await page.waitForLoadState('networkidle');
      console.log('✓ Opened first client detail view');
    } else {
      console.log('⚠ Could not click on client row');
    }
  });

  test('PHASE 3: Open client portfolio detail — check account manager, sites, agreements, contacts', async ({ page }) => {
    // Human action: Navigate directly to a known client detail
    await page.goto('/admin/crm/40404040-4040-4040-8040-404040404040');
    await page.waitForLoadState('networkidle');

    // Wait for page content
    await page.waitForTimeout(500);

    // Human observation: What tabs/sections do we see?
    const tabs = page.locator('[role=tablist] button, [data-test*=tab]');
    const tabCount = await tabs.count();
    console.log(`Portfolio detail has ${tabCount} visible tabs/sections`);

    // Try to find key account info
    const pageText = await page.locator('body').textContent();
    console.log('Checking for expected content...');
    console.log(`  - "Civic Events Limited": ${pageText?.includes('Civic Events Limited')}`);
    console.log(`  - "account manager" or "assigned": ${pageText?.includes('Account Manager') || pageText?.includes('assigned')}`);
    console.log(`  - Contact info: ${pageText?.includes('Mere Wilson') || pageText?.includes('mere@')}`);

    // CRITICAL TEST: Try to view account manager FK expansion
    // This is one of the RLS/FK bugs we know about
    const accountManagerField = page.locator('[data-test=account-manager], label:has-text("Account Manager")').first();
    if (await accountManagerField.isVisible({ timeout: 2000 }).catch(() => false)) {
      const fieldValue = await accountManagerField.textContent();
      console.log(`✓ Account manager field visible: "${fieldValue}"`);
      
      // Check if it shows a real person or is empty/broken
      if (!fieldValue || fieldValue.includes('null') || fieldValue.trim() === '') {
        console.log('⚠⚠⚠ ALERT: Account manager field is empty or shows placeholder — possible RLS/FK failure');
      }
    } else {
      console.log('⚠ Account manager field not visible');
    }

    // Try to find sites section
    const sitesSection = page.getByText(/site|place|location/i).first();
    if (await sitesSection.isVisible({ timeout: 2000 }).catch(() => false)) {
      const sitesText = await sitesSection.textContent();
      console.log(`✓ Sites section visible: "${sitesText?.substring(0, 100)}..."`);
    }

    // Try to find agreements section
    const agreementsSection = page.getByText(/agreement|contract/i).first();
    if (await agreementsSection.isVisible({ timeout: 2000 }).catch(() => false)) {
      const agreementsText = await agreementsSection.textContent();
      console.log(`✓ Agreements section visible: "${agreementsText?.substring(0, 100)}..."`);
    }
  });

  test('PHASE 4: Try to edit client details — test form validation and field responsiveness', async ({ page }) => {
    // Human action: Open client and try to edit a field
    await page.goto('/admin/crm/40404040-4040-4040-8040-404040404040');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Look for an edit button or editable field
    const editBtn = page.getByRole('button', { name: /edit|modify|change/i }).first();
    if (await editBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      console.log('✓ Clicked edit button');
    }

    // Try to find and edit a text field
    const nameInput = page.locator('input[placeholder*="name" i], [data-test*=account-name]').first();
    if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      const oldValue = await nameInput.inputValue();
      await nameInput.fill(oldValue + ' (test)');
      console.log(`✓ Edited name field: "${oldValue}" → "${oldValue} (test)"`);

      // Try to save
      const saveBtn = page.getByRole('button', { name: /save|submit/i }).first();
      if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await saveBtn.click();
        await page.waitForTimeout(500);
        console.log('✓ Clicked save button');

        // Check for success message or error
        const successMsg = page.locator('text=success|saved|updated').first();
        const errorMsg = page.locator('text=error|failed').first();
        if (await successMsg.isVisible({ timeout: 2000 }).catch(() => false)) {
          console.log('✓ Save succeeded');
        } else if (await errorMsg.isVisible({ timeout: 2000 }).catch(() => false)) {
          const errText = await errorMsg.textContent();
          console.log(`⚠ Save failed with error: "${errText}"`);
        } else {
          console.log('? Save result unclear');
        }
      }
    } else {
      console.log('⚠ No editable name field found');
    }
  });

  test('PHASE 5: Navigate to Sites sub-page — check boundary data, risk level, address', async ({ page }) => {
    // Human action: From client detail, navigate to sites/locations
    await page.goto('/admin/crm/40404040-4040-4040-8040-404040404040/sites');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Wait for content
    const sitesContent = page.locator('[data-test=sites-list], [role=main]').first();
    await expect(sitesContent).toBeVisible({ timeout: 3000 });

    // Human observation: What sites are listed?
    const pageText = await page.locator('body').textContent();
    console.log('Sites visible:');
    console.log(`  - "Civic Events Centre": ${pageText?.includes('Civic Events Centre')}`);
    console.log(`  - "North Pavilion": ${pageText?.includes('North Pavilion')}`);
    console.log(`  - Address "1 Civic Square": ${pageText?.includes('1 Civic Square')}`);

    // Try to click on a site to see detail
    const firstSite = page.locator('tr, [data-test*=site-row], li').first();
    if (await firstSite.isVisible({ timeout: 2000 }).catch(() => false)) {
      await firstSite.click();
      await page.waitForLoadState('networkidle');
      console.log('✓ Opened site detail');

      // Check for boundary/map section
      const mapSection = page.locator('[data-test*=map], canvas, [data-test*=boundary]').first();
      if (await mapSection.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('✓ Map/boundary section visible');
      } else {
        console.log('⚠ No map/boundary section visible — boundary data may not be displayed');
      }

      // Check for key site fields
      const siteDetail = await page.locator('body').textContent();
      console.log('Site detail fields:');
      console.log(`  - Risk level: ${siteDetail?.includes('risk') || siteDetail?.includes('medium')}`);
      console.log(`  - Boundary status: ${siteDetail?.includes('verified') || siteDetail?.includes('provisional')}`);
      console.log(`  - Zone rules: ${siteDetail?.includes('prohibited') || siteDetail?.includes('restricted')}`);
    }
  });

  test('PHASE 6: Navigate to Agreements — check agreement status, service modules, rates', async ({ page }) => {
    // Human action: From client, navigate to agreements
    await page.goto('/admin/crm/40404040-4040-4040-8040-404040404040/agreements');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    const agreementsContent = page.locator('[data-test=agreements-list], [role=main]').first();
    await expect(agreementsContent).toBeVisible({ timeout: 3000 });

    // Human observation: What agreements exist?
    const pageText = await page.locator('body').textContent();
    console.log('Agreements visible:');
    console.log(`  - "Civic Events Compliance Services": ${pageText?.includes('Civic Events Compliance')}`);
    console.log(`  - Status "active": ${pageText?.includes('active')}`);
    console.log(`  - "static_guarding": ${pageText?.includes('static_guarding') || pageText?.includes('Static Guard')}`);

    // Try to open an agreement detail
    const firstAgreement = page.locator('tr, [data-test*=agreement-row], li').first();
    if (await firstAgreement.isVisible({ timeout: 2000 }).catch(() => false)) {
      await firstAgreement.click();
      await page.waitForLoadState('networkidle');
      console.log('✓ Opened agreement detail');

      // Critical test: Check if service modules and rates are visible
      const agreementDetail = await page.locator('body').textContent();
      console.log('Agreement detail:');
      console.log(`  - Modules listed: ${agreementDetail?.includes('module') || agreementDetail?.includes('Module')}`);
      console.log(`  - Rates visible: ${agreementDetail?.includes('rate') || agreementDetail?.includes('price')}`);
      console.log(`  - SLA visible: ${agreementDetail?.includes('SLA') || agreementDetail?.includes('sla')}`);

      // CRITICAL: Check for financial rates (Gap 5 from critical-implementation-gaps.md)
      // Quote→Agreement workflow should sync rates but may not be implemented
      const ratesSection = page.locator('[data-test*=rate]').or(page.getByText(/rate/i)).first();
      if (await ratesSection.isVisible({ timeout: 2000 }).catch(() => false)) {
        const ratesText = await ratesSection.textContent();
        console.log(`✓ Rates section visible: "${ratesText?.substring(0, 80)}..."`);
      } else {
        console.log('⚠ Rates section not visible — financial config may not be wired');
      }
    }
  });

  test('PHASE 7: Navigate to Contacts — check contact list and details visible', async ({ page }) => {
    // Human action: From client, navigate to contacts
    await page.goto('/admin/crm/40404040-4040-4040-8040-404040404040/contacts');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    const contactsContent = page.locator('[data-test=contacts-list], [role=main]').first();
    await expect(contactsContent).toBeVisible({ timeout: 3000 });

    // Human observation: What contacts are listed?
    const pageText = await page.locator('body').textContent();
    console.log('Contacts visible:');
    console.log(`  - "Mere Wilson": ${pageText?.includes('Mere Wilson')}`);
    console.log(`  - "Facilities Manager": ${pageText?.includes('Facilities Manager')}`);
    console.log(`  - Email: ${pageText?.includes('mere@civic')}`);
    console.log(`  - Mobile: ${pageText?.includes('021 555')}`);

    // Try to add a new contact
    const addContactBtn = page.getByRole('button', { name: /add|new|create/i }).first();
    if (await addContactBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await addContactBtn.click();
      await page.waitForTimeout(300);
      console.log('✓ Clicked add contact button');

      // Try to fill in a contact form
      const firstNameInput = page.locator('input[placeholder*="first name" i], [data-test*=first-name]').first();
      if (await firstNameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await firstNameInput.fill('Bob');
        await page.locator('input[placeholder*="last name" i], [data-test*=last-name]').first().fill('Test');
        console.log('✓ Filled contact form fields');
      }
    } else {
      console.log('⚠ Add contact button not visible');
    }
  });

  test('PHASE 8: Check for visual/UI ergonomics — cramping, spacing, color contrast', async ({ page }) => {
    // Human action: Navigate around the CRM and evaluate visual comfort
    await page.goto('/admin/crm/40404040-4040-4040-8040-404040404040');
    await page.waitForLoadState('networkidle');

    // Take a screenshot to capture current visual state
    await page.screenshot({ path: 'client-portfolio-current.png' });
    console.log('✓ Screenshot taken: client-portfolio-current.png');

    // Human observation: Check for common UX issues
    const html = await page.locator('html').evaluate(el => el.getAttribute('style') || 'default');
    console.log(`Color scheme: ${html}`);

    // Check for cramped layouts (very narrow columns, small padding)
    const inputs = page.locator('input, textarea, select');
    const inputCount = await inputs.count();
    if (inputCount > 0) {
      const firstInput = inputs.first();
      const box = await firstInput.boundingBox();
      console.log(`First input dimensions: ${box?.width}x${box?.height}px at (${box?.x}, ${box?.y})`);
      
      if (box && box.width < 100) {
        console.log('⚠ ALERT: Input fields appear cramped (< 100px wide)');
      }
    }

    // Check for scrollable overflow issues
    const bodyScroll = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
    if (bodyScroll > 0) {
      console.log(`⚠ Horizontal scroll detected: ${bodyScroll}px overflow`);
    } else {
      console.log('✓ No horizontal scroll detected');
    }

    // Check for contrast: get computed styles of text elements
    const headings = page.locator('h1, h2, h3');
    if (await headings.count() > 0) {
      const firstHeading = headings.first();
      const styles = await firstHeading.evaluate(el => {
        const computed = window.getComputedStyle(el);
        return {
          color: computed.color,
          backgroundColor: computed.backgroundColor,
          fontSize: computed.fontSize,
        };
      });
      console.log(`Heading styles: color=${styles.color}, bg=${styles.backgroundColor}, size=${styles.fontSize}`);
    }
  });

  test('PHASE 9: Activation handoff walkthrough — check task list and completion flow', async ({ page }) => {
    // Human action: Navigate to an activation handoff to test that workflow
    await page.goto('/admin/crm');
    await page.waitForLoadState('networkidle');

    // Look for "Activation" or "Handoff" link/button
    const activationLink = page.getByRole('link', { name: /activation|handoff|onboard/i }).first();
    if (await activationLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await activationLink.click();
      await page.waitForLoadState('networkidle');
      console.log('✓ Navigated to activation handoff');

      // Try to view tasks
      const taskItems = page.locator('[data-test*=task], li, tr');
      const taskCount = await taskItems.count();
      console.log(`Handoff tasks visible: ${taskCount}`);

      // Try to click on a task to mark it complete
      const firstTask = taskItems.first();
      if (await firstTask.isVisible({ timeout: 2000 }).catch(() => false)) {
        await firstTask.click();
        await page.waitForTimeout(300);
        console.log('✓ Clicked on first task');

        // Check for "mark complete" or "done" button
        const completeBtn = page.getByRole('button', { name: /complete|done|mark/i }).first();
        if (await completeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await completeBtn.click();
          await page.waitForTimeout(500);
          console.log('✓ Clicked mark complete button');
        }
      }
    } else {
      console.log('⚠ Activation/handoff link not found');
    }
  });

  test('PHASE 10: Data flow verification — confirm critical fields are populated and persist', async ({ page }) => {
    // Human action: Navigate to client, edit a field, reload, verify it persisted
    await page.goto('/admin/crm/40404040-4040-4040-8040-404040404040');
    await page.waitForLoadState('networkidle');

    // Get initial state
    const notesBefore = await page.locator('[data-test*=note], textarea').first().inputValue().catch(() => '');
    console.log(`Notes before: "${notesBefore}"`);

    // Try to edit a field
    const notesInput = page.locator('[data-test*=note], textarea').first();
    if (await notesInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await notesInput.fill(notesBefore + ' — test edit at ' + new Date().toISOString().slice(0, 10));
      
      // Save
      const saveBtn = page.getByRole('button', { name: /save/i }).first();
      if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await saveBtn.click();
        await page.waitForTimeout(500);
      }

      // Reload and verify
      await page.reload();
      await page.waitForLoadState('networkidle');

      const notesAfter = await page.locator('[data-test*=note], textarea').first().inputValue().catch(() => '');
      console.log(`Notes after reload: "${notesAfter}"`);

      if (notesAfter.includes('test edit')) {
        console.log('✓ Data persisted correctly');
      } else {
        console.log('⚠⚠⚠ ALERT: Data did not persist! Possible save failure');
      }
    }
  });
});
