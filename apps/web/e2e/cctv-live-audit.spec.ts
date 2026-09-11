import { expect, test } from '@playwright/test';

const LIVE_URL = 'https://www.fcmanager.co.nz';
const email = process.env.GRANDMASTER_TEST_EMAIL || '';
const password = process.env.GRANDMASTER_TEST_PASSWORD || '';

test.describe('CCTV live visual audit', () => {
  test('authenticated CCTV review page renders without data errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    const httpErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => {
      failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`);
    });
    page.on('response', async (response) => {
      if (response.status() >= 400) {
        httpErrors.push(`${response.status()} ${response.url()} ${(await response.text().catch(() => '')).slice(0, 500)}`);
      }
    });

    await page.goto(`${LIVE_URL}/admin`);
    const emailInput = page.locator('input[type="email"]').first();
    if (await emailInput.isVisible()) {
      await emailInput.fill(email);
      await page.locator('input[type="password"]').first().fill(password);
      await page.getByRole('button', { name: /sign in/i }).click();
    }
    await expect(page.locator('nav').first()).toBeVisible({ timeout: 20000 });
    const notNow = page.getByRole('button', { name: /not now/i });
    if (await notNow.isVisible().catch(() => false)) await notNow.click();
    await page.goto(`${LIVE_URL}/admin/field-ops?area=cctv-review`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2500);
    await page.screenshot({ path: 'test-results/cctv-live-desktop.png', fullPage: true });

    const bodyText = await page.locator('body').innerText();
    const boxes = await page.evaluate(() => Object.fromEntries(
      ['.cctv-review-page', '.cctv-review-layout', '.cctv-filter-rail', '.cctv-job-list', '.cctv-detail']
        .map((selector) => [selector, document.querySelector(selector)?.getBoundingClientRect().toJSON() || null]),
    ));
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }));

    console.log(JSON.stringify({ url: page.url(), bodyText: bodyText.slice(0, 5000), boxes, overflow, consoleErrors, failedRequests, httpErrors }));
    expect(page.locator('.cctv-review-page')).toBeVisible();
    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test('authenticated CCTV review page fits mobile viewport', async ({ page }) => {
    await page.goto(`${LIVE_URL}/admin`);
    const emailInput = page.locator('input[type="email"]').first();
    if (await emailInput.isVisible()) {
      await emailInput.fill(email);
      await page.locator('input[type="password"]').first().fill(password);
      await page.getByRole('button', { name: /sign in/i }).click();
    }
    await expect(page.locator('nav').first()).toBeVisible({ timeout: 20000 });
    const notNow = page.getByRole('button', { name: /not now/i });
    if (await notNow.isVisible().catch(() => false)) await notNow.click();
    await page.goto(`${LIVE_URL}/admin/field-ops?area=cctv-review`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2500);
    await page.screenshot({ path: 'test-results/cctv-live-mobile.png', fullPage: true });
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }));
    console.log(JSON.stringify({ url: page.url(), overflow, bodyText: (await page.locator('body').innerText()).slice(0, 3000) }));
    expect(page.locator('.cctv-review-page')).toBeVisible();
    expect(overflow.horizontal).toBe(false);
  });
});
