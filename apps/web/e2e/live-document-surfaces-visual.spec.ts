import { expect, test, type Page } from '@playwright/test';

const LIVE_URL = 'https://www.fcmanager.co.nz';
const email = process.env.GRANDMASTER_TEST_EMAIL || '';
const password = process.env.GRANDMASTER_TEST_PASSWORD || '';

type BrowserEvidence = { consoleErrors: string[]; requestErrors: string[]; httpErrors: string[] };

function monitor(page: Page): BrowserEvidence {
  const evidence: BrowserEvidence = { consoleErrors: [], requestErrors: [], httpErrors: [] };
  page.on('console', (message) => { if (message.type() === 'error') evidence.consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => evidence.consoleErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText || '';
    if (failure !== 'net::ERR_ABORTED') evidence.requestErrors.push(`${request.method()} ${request.url()} ${failure}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) evidence.httpErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  return evidence;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(`${LIVE_URL}/admin`, { waitUntil: 'domcontentloaded' });
  const emailInput = page.locator('input[type="email"]').first();
  if (await emailInput.isVisible().catch(() => false)) {
    await emailInput.fill(email);
    await page.locator('input[type="password"]').first().fill(password);
    await page.getByRole('button', { name: /sign.?in|login/i }).first().click();
  }
  await expect(page.locator('nav').first()).toBeVisible({ timeout: 30_000 });
  const dismiss = page.getByRole('button', { name: /not now/i }).first();
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
}

const surfaces = [
  { name: 'document-studio', path: '/admin/document-studio', marker: /Bob document studio/i, ready: /Document setup/i },
  { name: 'files', path: '/admin/files', marker: /File system/i, ready: /Permitted records|Files waiting registration/i },
  { name: 'locations', path: '/admin/locations', marker: /Locations/i, ready: /All Locations/i },
  { name: 'breach-review', path: '/admin/field-ops?area=breach-review', marker: /Breach Review|Compliance Breach/i, ready: /No breach records|Select Enforcement Action|Breach alert/i },
  { name: 'cctv-review', path: '/admin/field-ops?area=cctv-review', marker: /CCTV/i, ready: /Recent camera work|Select evidence/i },
] as const;

test.describe('production document workflow visual audit', () => {
  test.skip(!email || !password, 'Requires live test credentials in GRANDMASTER_TEST_EMAIL and GRANDMASTER_TEST_PASSWORD.');
  test.setTimeout(90_000);

  for (const surface of surfaces) {
    test(`${surface.name} renders without browser or horizontal layout errors`, async ({ page }, testInfo) => {
      const evidence = monitor(page);
      await signIn(page);
      await page.goto(`${LIVE_URL}${surface.path}`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('body')).toContainText(surface.marker, { timeout: 30_000 });
      await expect(page.locator('body')).toContainText(surface.ready, { timeout: 30_000 });
      const dismiss = page.getByRole('button', { name: 'Not now', exact: true });
      if (await dismiss.isVisible({ timeout: 2_000 }).catch(() => false)) await dismiss.click();
      await expect(page.getByText(/Module configuration.*loading/i).first()).not.toBeVisible({ timeout: 10_000 });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await page.screenshot({ path: testInfo.outputPath(`${surface.name}.png`), fullPage: true });
      const layout = await page.evaluate(() => ({
        url: window.location.href,
        viewport: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        bodyText: document.body.innerText.slice(0, 1200),
      }));
      console.log(JSON.stringify({ surface: surface.name, layout, evidence }));
      expect(layout.scrollWidth, `${surface.name} overflows horizontally`).toBeLessThanOrEqual(layout.viewport + 1);
      expect(evidence.consoleErrors, evidence.consoleErrors.join('\n')).toEqual([]);
      expect(evidence.requestErrors, evidence.requestErrors.join('\n')).toEqual([]);
      expect(evidence.httpErrors, evidence.httpErrors.join('\n')).toEqual([]);
    });
  }

  test('locations opens a site-scoped Bob safety-plan draft', async ({ page }) => {
    const evidence = monitor(page);
    await signIn(page);
    await page.goto(`${LIVE_URL}/admin/locations`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/All Locations/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Bob: Draft safety plan' }).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Bob: Draft safety plan' }).first().click();
    await expect(page).toHaveURL(/\/admin\/document-studio\?sourceType=site&sourceId=[0-9a-f-]+$/i, { timeout: 30_000 });
    await expect(page.getByRole('status', { name: 'Source context for document' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('status', { name: 'Source context for document' })).toContainText(/SITE/i);
    await expect(page.getByLabel('Document type')).toHaveValue('site_safety_plan');
    expect(evidence.consoleErrors, evidence.consoleErrors.join('\n')).toEqual([]);
    expect(evidence.requestErrors, evidence.requestErrors.join('\n')).toEqual([]);
    expect(evidence.httpErrors, evidence.httpErrors.join('\n')).toEqual([]);
  });

});
