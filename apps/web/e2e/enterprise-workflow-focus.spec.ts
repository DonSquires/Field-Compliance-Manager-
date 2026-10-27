import { expect, test, type Page } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

async function expectViewportContained(page: Page) {
  const size = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    windowY: scrollY,
  }));
  expect(size.width).toBeLessThanOrEqual(size.viewportWidth);
  expect(size.height).toBeLessThanOrEqual(size.viewportHeight);
  expect(size.windowY).toBe(0);
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const channels = color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number);
    if (!channels || channels.length !== 3) throw new Error(`Cannot measure contrast for ${color}`);
    const linear = channels.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

for (const workspace of [
  { route: '/admin/reports', selector: '.reports-hub-page' },
  { route: '/admin/investigations', selector: '.investigation-page' },
]) {
  test(`${workspace.route} uses the universal dark theme and accessible action contrast`, async ({ page }) => {
    await installSupabaseFixtures(page);
    await signInAsAdmin(page, workspace.route);
    const workspaceRoot = page.locator(workspace.selector);
    await expect(workspaceRoot).toBeVisible();
    const action = workspaceRoot.locator('button:visible:not(:disabled)').first();
    await expect(action).toBeVisible();
    await expect(page.locator('.admin-shell')).toHaveAttribute('data-theme', 'dark');
    const colours = await action.evaluate((button) => {
      const style = getComputedStyle(button);
      return { text: style.color, background: style.backgroundColor };
    });
    expect(contrastRatio(colours.text, colours.background)).toBeGreaterThanOrEqual(4.5);
    await expect(action).toHaveCSS('border-top-width', '1px');
    await expectViewportContained(page);
  });
}

test('overview keeps queue, ledger and exceptions inside the command viewport', async ({ page }, testInfo) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { officerModules: ['dispatch'] });
  await signInAsAdmin(page, '/admin/hub');
  await expect(page.getByRole('heading', { name: 'Today at a glance' })).toBeVisible();
  await expect(page.locator('.admin-console-status')).not.toContainText('Updating');
  await expect(page.locator('.admin-priority-queue')).toBeVisible();
  await expectViewportContained(page);
  const ribbon = page.getByRole('region', { name: 'Current operations metrics' });
  const metricContentFits = await ribbon.locator('.admin-metric').evaluateAll((cards) => cards.map((card) => {
    const bounds = card.getBoundingClientRect();
    const content = [...card.querySelectorAll(':scope > span, :scope > strong')];
    return content.every((item) => {
      const itemBounds = item.getBoundingClientRect();
      return itemBounds.left >= bounds.left - 1
        && itemBounds.right <= bounds.right + 1
        && itemBounds.top >= bounds.top - 1
        && itemBounds.bottom <= bounds.bottom + 1
        && item.scrollWidth <= item.clientWidth + 1;
    });
  }));
  expect(metricContentFits).toHaveLength(5);
  expect(metricContentFits).toEqual([true, true, true, true, true]);
  await expect(page).toHaveScreenshot('enterprise-command-overview.png');
  if (testInfo.project.name === 'mobile-chromium') {
    const panes = page.getByRole('navigation', { name: 'Overview panes' });
    await panes.getByRole('button', { name: 'Activity ledger' }).click();
    await expect(page.locator('.admin-console-activity')).toBeVisible();
    await expect(page.locator('.admin-priority-queue')).toBeHidden();
    await page.locator('.admin-trend-panel summary').click();
    await expect(page.locator('.admin-trend-panel table')).toBeVisible();
    await panes.getByRole('button', { name: 'Exceptions', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: 'Shift & compliance exceptions' })).toBeVisible();
  await expectViewportContained(page);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('priority rows scroll independently on short viewports', async ({ page }) => {
  await installSupabaseFixtures(page, { officerModules: ['dispatch'] });
  await page.route('**/rest/v1/dispatch_jobs?*', async (route) => {
    if (route.request().method() === 'HEAD') return route.fulfill({ headers: { 'content-range': '0-11/12' }, body: '' });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(Array.from({ length: 12 }, (_, index) => ({
      id: `console-dispatch-${index}`, job_type: 'alarm_response', priority: 'high', status: 'dispatched',
      sla_respond_by: '2026-08-29T13:00:00Z', created_at: '2026-08-29T11:00:00Z',
    }))) });
  });
  await signInAsAdmin(page, '/admin/hub');
  await expect(page.locator('.admin-priority-queue .admin-queue-row')).toHaveCount(12);
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 600 });
  const pane = page.locator('.admin-priority-queue .admin-pane-scroll');
  await expect.poll(() => pane.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await pane.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await expect.poll(() => pane.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await expectViewportContained(page);
});

test('organisation switches discard delayed queue responses from the previous scope', async ({ page }) => {
  const home = '33333333-3333-4333-8333-333333333333';
  const branch = '44444444-4444-4444-8444-444444444444';
  await installSupabaseFixtures(page, { officerModules: ['dispatch'] });
  await page.route('**/rest/v1/rpc/get_operating_organization_contexts', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([home, branch].map((id, index) => ({
      organization_id: id, organization_name: index ? 'Branch operations' : 'Home operations',
      authority_basis: index ? 'corporate_oversight' : 'organisation_home', role_at_branch: null,
      module_access: [], can_be_rostered: false, is_default: index === 0,
    }))),
  }));
  let releaseHome!: () => void;
  const homeGate = new Promise<void>((resolve) => { releaseHome = resolve; });
  let delayed = 0;
  await page.route('**/rest/v1/dispatch_jobs?*', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'HEAD') return route.fallback();
    const oldScope = url.searchParams.get('organization_id') === `eq.${home}`;
    if (oldScope) { delayed += 1; await homeGate; }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{
      id: oldScope ? 'old-scope-job' : 'current-scope-job',
      job_type: oldScope ? 'previous_scope_dispatch' : 'current_scope_dispatch',
      priority: 'high', status: 'dispatched', sla_respond_by: null, created_at: '2026-08-29T11:00:00Z',
    }]) });
  });
  await signInAsAdmin(page, '/admin/hub');
  await expect.poll(() => delayed).toBeGreaterThan(0);
  await page.getByLabel('Account and workspace tools').click();
  await page.getByRole('combobox', { name: 'Working in' }).selectOption(branch);
  const queue = page.locator('.admin-priority-queue');
  await expect(queue).toContainText('current scope dispatch');
  releaseHome();
  await page.clock.runFor(100);
  await expect(page.locator('.admin-console-status')).not.toContainText('Updating');
  await expect(queue).toContainText('current scope dispatch');
  await expect(queue).not.toContainText('previous scope dispatch');
  await expectViewportContained(page);
});

test('failed reads remain visible without reporting a clear queue', async ({ page }) => {
  await installSupabaseFixtures(page, { officerModules: ['dispatch'] });
  await page.route('**/rest/v1/dispatch_jobs?*', async (route) => route.fulfill({
    status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Operational read denied.' }),
  }));
  await signInAsAdmin(page, '/admin/hub');
  await expect(page.locator('.admin-data-warning')).toContainText('Some operational data is unavailable');
  await expect(page.locator('.admin-console-status')).toContainText('unavailable');
  await expect(page.locator('.admin-priority-queue')).not.toContainText('Queue clear');
  await expectViewportContained(page);
});

test('field workflow panes filter only entitled routes and retain navigation', async ({ page }, testInfo) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { officerModules: ['dispatch', 'patrol', 'parking_enforcement'] });
  await signInAsAdmin(page, '/admin/field-ops?area=landing');
  const query = page.getByRole('searchbox', { name: 'Find a workflow' });
  await expect(query).toBeVisible();
  await query.fill('no matching operational tool');
  await expect(page.locator('.field-ops-respond')).toContainText('No matching workflows');
  await expect(page.locator('.field-ops-workflow:visible')).toHaveCount(0);
  await query.fill('');
  await expectViewportContained(page);
  await expect(page).toHaveScreenshot('enterprise-field-workbench.png');
  if (testInfo.project.name === 'mobile-chromium') {
    await page.getByRole('navigation', { name: 'Workflow panes' }).getByRole('button', { name: /Operational records/ }).click();
  }
  await page.locator('.field-ops-workflow').filter({ hasText: 'Vehicle search' }).click();
  await expect(page).toHaveURL(/area=vehicle-search/);
  await expectViewportContained(page);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});
