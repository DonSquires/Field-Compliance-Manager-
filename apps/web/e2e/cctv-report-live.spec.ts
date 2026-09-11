import { expect, test, type Page } from '@playwright/test';

const LIVE_URL = 'https://www.fcmanager.co.nz';
const email = process.env.GRANDMASTER_TEST_EMAIL || '';
const password = process.env.GRANDMASTER_TEST_PASSWORD || '';
const liveEnabled = process.env.CCTV_REPORT_LIVE === 'true';
const targetJobPrefix = process.env.CCTV_REPORT_JOB_PREFIX || '';

type BrowserEvidence = {
  consoleErrors: string[];
  httpErrors: string[];
};

function monitor(page: Page): BrowserEvidence {
  const evidence: BrowserEvidence = { consoleErrors: [], httpErrors: [] };
  page.on('console', (message) => {
    if (message.type() === 'error') evidence.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => evidence.consoleErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) {
      const url = new URL(response.url());
      evidence.httpErrors.push(`${response.status()} ${url.pathname}`);
    }
  });
  return evidence;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(`${LIVE_URL}/admin`, { waitUntil: 'domcontentloaded' });
  const emailInput = page.getByLabel('Email address').or(page.locator('input[type="email"]')).first();
  if (await emailInput.isVisible()) {
    await emailInput.fill(email);
    await page.getByLabel('Password').or(page.locator('input[type="password"]')).first().fill(password);
    await page.getByRole('button', { name: /sign.?in|login/i }).first().click();
  }
  await expect(page.locator('nav').first()).toBeVisible({ timeout: 20_000 });
  const dismiss = page.getByRole('button', { name: 'Not now', exact: true });
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
}

async function selectCompletedEvidenceWithPhoto(page: Page): Promise<void> {
  await page.goto(`${LIVE_URL}/admin/field-ops?area=cctv-review`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.cctv-review-page')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.cctv-job-row').first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /^Complete\s*\d*$/ }).click();
  await expect(page.locator('.cctv-job-row').first()).toBeVisible({ timeout: 30_000 });

  const rows = page.locator('.cctv-job-row-main');
  if (targetJobPrefix) {
    const target = rows.filter({ hasText: targetJobPrefix }).first();
    await expect(target).toBeVisible({ timeout: 20_000 });
    await target.click();
    await expect(page.getByRole('button', { name: /Observations \((?!0\))/ }).first()).toBeVisible({ timeout: 20_000 });
    return;
  }
  const count = Math.min(await rows.count(), 15);
  for (let index = 0; index < count; index += 1) {
    await rows.nth(index).click();
    await page.waitForTimeout(600);
    const observations = page.getByRole('button', { name: /Observations \((?!0\))/ });
    if (await observations.count()) {
      await observations.first().click();
      if (await page.locator('.cctv-observation-card img').count()) return;
    }
    const frames = page.getByRole('button', { name: /Frames \((?!0\))/ });
    if (await frames.count()) {
      await frames.first().click();
      if (await page.locator('.cctv-keyframe-item img').count()) return;
    }
  }
  throw new Error('No completed CCTV item with a report-safe evidence photograph was found.');
}

test.describe('live CCTV client report acceptance', () => {
  test.skip(!liveEnabled || !email || !password, 'Requires CCTV_REPORT_LIVE=true and dedicated live test credentials.');
  test.setTimeout(120_000);

  test('issues one draft receipt and renders a client-ready photographic assessment', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => {
      window.print = () => undefined;
    });
    const page = await context.newPage();
    const pageEvidence = monitor(page);
    await signIn(page);
    await selectCompletedEvidenceWithPhoto(page);

    await page.screenshot({ path: 'test-results/cctv-client-review-page.png', fullPage: true });

    const popupPromise = context.waitForEvent('page', { timeout: 30_000 });
    await page.getByRole('button', { name: /Print draft report/i }).click();
    const reportPage = await popupPromise;
    const reportEvidence = monitor(reportPage);
    await reportPage.waitForLoadState('domcontentloaded').catch(() => undefined);
    await expect(reportPage.getByRole('heading', { name: /CCTV evidence report/i })).toBeVisible({ timeout: 15_000 });

    await reportPage.screenshot({ path: 'test-results/cctv-client-report.png', fullPage: true });
    await reportPage.pdf({ path: 'test-results/cctv-client-report.pdf', format: 'A4', printBackground: true });

    for (const heading of ['Evidence provenance', 'Client assessment', 'Evidence photographs', 'Consolidated observations']) {
      await expect(reportPage.getByRole('heading', { name: heading })).toBeVisible();
    }
    for (const label of ['What', 'When', 'Where', 'Why', 'How']) {
      await expect(reportPage.locator('dt', { hasText: label })).toBeVisible();
    }
    await expect(reportPage.getByText(/No breach or identity conclusion is inferred/)).toBeVisible();
    await expect(reportPage.getByText(/AI inference is advisory|This report is not final compliance/)).toBeVisible();
    const reportText = await reportPage.locator('body').innerText();
    const partialBatch = reportText.includes('PARTIAL:');
    if (partialBatch) await expect(reportPage.getByText(/PARTIAL:/)).toBeVisible();

    const photos = reportPage.locator('.evidence-grid img');
    expect(await photos.count()).toBeGreaterThan(0);
    expect(await photos.count()).toBeLessThanOrEqual(6);
    for (let index = 0; index < await photos.count(); index += 1) {
      expect(await photos.nth(index).getAttribute('src')).toMatch(/^data:image\//);
      expect((await photos.nth(index).getAttribute('alt'))?.trim()).toBeTruthy();
    }
    const captions = await reportPage.locator('.evidence-grid figcaption').allInnerTexts();
    expect(captions.every((caption) => /\d+(?:\.\d+)?s/.test(caption))).toBe(true);
    expect(captions.every((caption) => /Frame hash/.test(caption))).toBe(true);
    expect(captions.every((caption) => /Review state:/.test(caption))).toBe(true);

    const width = await reportPage.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(width.scrollWidth).toBeLessThanOrEqual(width.clientWidth);
    expect(pageEvidence.consoleErrors).toEqual([]);
    expect(pageEvidence.httpErrors).toEqual([]);
    expect(reportEvidence.consoleErrors).toEqual([]);
    expect(reportEvidence.httpErrors).toEqual([]);
    await expect(page.getByLabel('CCTV report receipt')).toContainText('Report receipt issued');

    console.log(JSON.stringify({
      reportImageCount: await photos.count(),
      observationRowCount: await reportPage.locator('tbody tr').count(),
      reportStatus: (await reportPage.locator('.meta').innerText()).includes('draft') ? 'draft' : 'review_ready',
      partialBatch,
      receiptRecorded: true,
      width,
    }));
    await context.close();
  });
});
