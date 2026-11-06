import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin, signInAsOfficer } from './fixtures';

test.beforeEach(async ({ page }) => {
  await installSupabaseFixtures(page);
});

test('administrator opens and dismisses the governed Bob workspace accessibly', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/hub');
  const opener = page.getByRole('button', { name: 'Open Bob command center' });
  await opener.click();
  await expect(page).toHaveURL(/\/admin\/hub$/);
  const panel = page.getByLabel('Bob agent workspace');
  await expect(panel).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Bob agent workspace' })).toBeVisible();
  await expect(panel).not.toHaveAttribute('aria-modal', 'true');
  await expect(panel.getByText('Governed session')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Plan work' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Start voice capture' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Close Bob' })).toBeVisible();
  await expect(panel).toHaveClass(/is-docked/);
  const content = page.locator('[data-app-content]');
  const pageBox = (await content.boundingBox())!;
  const panelBox = (await panel.boundingBox())!;
  expect(pageBox.width).toBeGreaterThan(250);
  expect(pageBox.height).toBeGreaterThan(100);
  if (page.viewportSize()!.width > 900) expect(pageBox.x + pageBox.width).toBeLessThanOrEqual(panelBox.x + 1);
  else expect(pageBox.y + pageBox.height).toBeLessThanOrEqual(panelBox.y + 1);
  await opener.focus();
  await page.keyboard.press('Tab');
  expect(await panel.evaluate(element => element.contains(document.activeElement))).toBe(false);
  await expect(panel.getByRole('button', { name: 'Show sessions' })).toBeVisible();
  await panel.getByRole('button', { name: 'Show sessions' }).click();
  await expect(panel.getByLabel('Bob sessions')).toBeVisible();
  await panel.getByRole('button', { name: 'Close sessions' }).click();
  await expect(panel.getByLabel('Bob context panel')).toBeHidden();
  await expect(panel.locator('textarea[placeholder="Ask Bob to plan, inspect, explain, or prepare a proposal"]')).toBeVisible();
  await expect(panel).toHaveScreenshot('bob-panel.png');
  await expect(page).toHaveScreenshot('bob-panel-full-page.png', { fullPage: true });

  await panel.getByRole('button', { name: 'Open document studio' }).click();
  const studio = panel.getByLabel('Bob studio');
  await expect(studio).toBeVisible();
  await expect(studio.getByRole('tab', { name: /Documents/ })).toBeVisible();
  await expect(studio.getByRole('tab', { name: /Diagrams/ })).toBeVisible();
  await expect(studio.getByRole('tab', { name: /Media/ })).toBeVisible();
  await expect(studio.getByRole('button', { name: /RFQ response/ })).toBeVisible();
  await expect(studio.getByRole('button', { name: /Employment contract draft/ })).toBeVisible();
  await expect(studio.getByRole('button', { name: /Report design/ })).toBeVisible();
  await expect(panel).toHaveScreenshot('bob-studio.png');

  await panel.getByRole('button', { name: 'Show context panel' }).click();
  await expect(panel.getByLabel('Bob context panel')).toBeVisible();
  await expect(panel.getByLabel('Bob context panel')).toContainText('hub');
  await expect(panel.getByRole('tab', { name: 'Audit' })).toBeVisible();
  await panel.getByRole('button', { name: 'Close Bob' }).click();
  await expect(panel).toBeHidden();
  await expect(page).toHaveURL(/\/admin\/hub$/);
  await expect(opener).toBeFocused();
  const restoredBox = (await content.boundingBox())!;
  if (page.viewportSize()!.width > 900) expect(restoredBox.width).toBeGreaterThan(pageBox.width);
  else expect(restoredBox.height).toBeGreaterThan(pageBox.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('an officer opens Bob full screen from a standalone specialty module and returns with Back', async ({ page }) => {
  await installSupabaseFixtures(page, { officerModules: ['freedom_camping'] });
  await signInAsOfficer(page, '/modules/freedom_camping');
  await expect(page.getByText('Freedom Camping', { exact: true })).toBeVisible();

  const opener = page.getByRole('button', { name: 'Open Bob assistant' });
  await opener.click();
  const panel = page.getByRole('dialog', { name: 'Bob assistant' });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('aria-modal', 'true');
  await expect(panel).toHaveClass(/is-fullscreen/);
  await expect(panel.getByLabel('Bob sessions')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Show context panel' })).toHaveCount(0);
  const back = panel.getByRole('button', { name: 'Back to the field portal' });
  await expect(back).toBeFocused();
  await back.click();
  await expect(panel).toBeHidden();
  await expect(opener).toBeFocused();

  await opener.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});

test('guidance buttons send explicit direction with fresh page context and allow text overrides', async ({ page }) => {
  let lastRequest: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/bob_conversations*', route => route.fulfill({
    json: new URL(route.request().url()).searchParams.get('select') === 'id' ? { id: 'conversation-1' } : [],
  }));
  await page.route('**/rest/v1/bob_messages*', route => route.fulfill({ json: [{
    id: 'pause-1', role: 'assistant', content: 'Shall I continue from where I left off?',
    metadata: { continuation_pending: true }, created_at: '2026-08-29T12:00:00Z',
  }] }));
  await page.route('**/functions/v1/onspace-ai-chat', async route => {
    lastRequest = route.request().postDataJSON();
    await route.fulfill({ json: { reply: 'Direction recorded' } });
  });
  await signInAsAdmin(page, '/admin/hub');
  await page.getByRole('button', { name: 'Open Bob command center' }).click();
  const panel = page.getByRole('complementary', { name: 'Bob agent workspace' });
  const proceed = panel.getByRole('button', { name: 'Continue from where you left off' });
  await expect(proceed).toBeEnabled();
  await expect(proceed).toHaveAttribute('aria-description', 'Recommended by Bob');
  const input = panel.getByRole('textbox');
  await input.fill('Only review the current page. Do not change records.');
  await expect(proceed).toBeDisabled();
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => lastRequest).not.toBeNull();
  expect(lastRequest).toMatchObject({
    operation: 'enqueue',
    message: 'Only review the current page. Do not change records.',
    context: { page: 'hub', visible_page: { path: '/admin/hub' } },
  });
  expect(JSON.stringify(lastRequest)).not.toContain('Continue from where you left off');
});