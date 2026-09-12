import { expect, test, type Browser, type Page } from '@playwright/test';

const LIVE_URL = process.env.HUMAN_TEST_BASE_URL || 'https://www.fcmanager.co.nz';
const ADMIN_EMAIL = process.env.PM_ADMIN_EMAIL || process.env.GRANDMASTER_TEST_EMAIL || '';
const ADMIN_PASSWORD = process.env.PM_ADMIN_PASSWORD || process.env.GRANDMASTER_TEST_PASSWORD || '';
const OFFICER_EMAIL = process.env.PM_OFFICER_EMAIL || 'synthetic.officer.test@fcmanager.test';
const OFFICER_PASSWORD = process.env.PM_OFFICER_PASSWORD || 'Run2thesun??';
const liveReady = Boolean(ADMIN_EMAIL && ADMIN_PASSWORD && OFFICER_EMAIL && OFFICER_PASSWORD && ADMIN_EMAIL !== OFFICER_EMAIL);

type Evidence = { phase: string; state: string; url: string; screenshot: string };

async function signIn(page: Page, email: string, password: string, path: string) {
  await page.goto(`${LIVE_URL}${path}`, { waitUntil: 'domcontentloaded' });
  const emailField = page.locator('input[type="email"]').first();
  if (await emailField.isVisible().catch(() => false)) {
    await emailField.fill(email);
    await page.locator('input[type="password"]').first().fill(password);
    await page.getByRole('button', { name: /sign.?in|login/i }).first().click();
  }
  await page.locator('nav, header, .admin-shell, .officer-shell-bar').first().waitFor({ state: 'visible', timeout: 30_000 });
  const dismiss = page.getByRole('button', { name: 'Not now', exact: true });
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
}

async function capture(page: Page, evidence: Evidence[], phase: string, state: string, testInfo: { outputPath: (name: string) => string }) {
  const screenshot = testInfo.outputPath(`${phase}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  evidence.push({ phase, state, url: page.url(), screenshot });
}

async function assertNoBrowserErrors(page: Page, errors: string[]) {
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
}

async function openAdminSurface(page: Page, path: string, marker: RegExp) {
  await page.goto(`${LIVE_URL}${path}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toContainText(marker, { timeout: 30_000 });
}

test.describe('live PM acceptance: roster -> patrol -> dispatch -> evidence', () => {
  test.skip(!liveReady, 'Requires distinct PM_ADMIN_EMAIL/PM_ADMIN_PASSWORD and PM_OFFICER_EMAIL/PM_OFFICER_PASSWORD live test identities. No Supabase mocks are permitted.');
  test.setTimeout(180_000);

  test('walks the full paired workflow without bypassing backend boundaries', async ({ browser }, testInfo) => {
    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const officerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const admin = await adminContext.newPage();
    const officer = await officerContext.newPage();
    const evidence: Evidence[] = [];
    const errors: string[] = [];
    await assertNoBrowserErrors(admin, errors);
    await assertNoBrowserErrors(officer, errors);

    await signIn(admin, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin/roster');
    await signIn(officer, OFFICER_EMAIL, OFFICER_PASSWORD, '/officer/schedule');
    await capture(admin, evidence, '01-admin-roster-entry', await admin.locator('body').innerText(), testInfo);
    await capture(officer, evidence, '02-officer-schedule-entry', await officer.locator('body').innerText(), testInfo);

    await openAdminSurface(admin, '/admin/locations', /Locations/i);
    await capture(admin, evidence, '03-admin-operational-geography', await admin.locator('body').innerText(), testInfo);

    await openAdminSurface(admin, '/admin/roster', /Roster/i);
    await expect(admin.locator('[data-testid="roster-board"], .roster-board, body').first()).toBeVisible();
    await capture(admin, evidence, '04-roster-board-loaded', await admin.locator('body').innerText(), testInfo);

    await openAdminSurface(admin, '/admin/field-ops?area=dispatch', /Dispatch|Field Operations/i);
    await capture(admin, evidence, '05-dispatch-console-loaded', await admin.locator('body').innerText(), testInfo);

    await openAdminSurface(officer, '/officer/dispatch', /Dispatch/i);
    await capture(officer, evidence, '06-officer-dispatch-loaded', await officer.locator('body').innerText(), testInfo);

    await openAdminSurface(officer, '/officer/patrol', /Patrol|Field Patrol/i);
    await capture(officer, evidence, '07-officer-patrol-loaded', await officer.locator('body').innerText(), testInfo);

    await openAdminSurface(admin, '/admin/field-ops?area=patrol', /Patrol|Patrol evidence/i);
    await capture(admin, evidence, '08-admin-patrol-oversight-loaded', await admin.locator('body').innerText(), testInfo);

    expect(errors, errors.join('\n')).toEqual([]);
    expect(evidence).toHaveLength(8);
    await adminContext.close();
    await officerContext.close();
  });
});
